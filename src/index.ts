#!/usr/bin/env node
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, localhostAllowedHostnames, validateOriginHeader } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMcpServer, getAgentVersion, getSdkVersion } from "./server";
import { error } from "./logger";
import { Request, Response } from "express";
import { program } from "commander";
import { createServer, IncomingMessage } from "node:http";
import { isIP } from "node:net";

type InstallOptions = { yes?: boolean };

const logMcpError = (err: Error) => {
	error("Error handling MCP request: " + (err.stack ?? String(err)));
};

const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

const parsePort = (value: string) => {
	const port = Number(value);
	return /^[0-9]+$/.test(value) && port >= 1 && port <= 65535 ? port : undefined;
};

const isHttpAuthority = (value: string) => {
	const match = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([0-9]+))?$/i.exec(value);
	if (!match || (match[2] !== undefined && parsePort(match[2]) === undefined)) {
		return false;
	}
	const hostname = match[1];
	if (hostname.startsWith("[")) {
		return isIP(hostname.slice(1, -1)) === 6;
	}
	if (isIP(hostname) === 4) {
		return true;
	}

	// WHATWG URLs interpret a final numeric label as IPv4. Accept only canonical IPv4 above.
	const labels = hostname.split(".");
	const numericLabel = /^(?:[0-9]+|0x[0-9a-f]*)$/i;
	return hostname.length <= 253 && labels.every(label => dnsLabel.test(label)) &&
		!numericLabel.test(labels[labels.length - 1]);
};

// The first "?" starts the optional query, which also permits additional "?" characters.
const originFormTarget = /^\/(?!\/)(?:[a-z0-9!$&'()*+,.:;=?@_~\/-]|%[a-f0-9]{2})*$/i;

const invalidHttpHeader = (req: IncomingMessage) => {
	// Unlike req.headers, headersDistinct retains duplicate field lines.
	const { host, origin } = req.headersDistinct;
	if (host?.length !== 1 || !isHttpAuthority(host[0])) {
		return "Invalid Host header";
	}
	if (origin !== undefined) {
		const match = origin.length === 1 && /^https?:\/\/(.+)$/i.exec(origin[0]);
		if (!match || !isHttpAuthority(match[1])) {
			return "Invalid Origin header";
		}
	}
};

const startHttpServer = async (host: string, port: number) => {
	const authToken = process.env.MOBILEMCP_AUTH;
	const configuredHosts = process.env.MOBILEMCP_ALLOWED_HOSTS;
	const loopbackHosts = localhostAllowedHostnames();
	let app;
	if (configuredHosts === undefined) {
		app = createMcpExpressApp({ host });
	} else {
		const hostnames = configuredHosts.split(",").map(value => value.trim());
		for (const hostname of hostnames) {
			const labels = hostname.split(".");
			if (hostname.length > 253 || labels.length < 2 ||
				!labels.every(label => dnsLabel.test(label)) || !/^[a-z]/i.test(labels[labels.length - 1])) {
				error("Invalid MOBILEMCP_ALLOWED_HOSTS. Expected comma-separated ASCII DNS hostnames without ports or wildcards.");
				process.exit(1);
			}
		}
		if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
			error("MOBILEMCP_ALLOWED_HOSTS requires a loopback --listen address.");
			process.exit(1);
		}
		if (!authToken || !/^[A-Za-z0-9._~+\/-]+=*$/.test(authToken)) {
			error("MOBILEMCP_ALLOWED_HOSTS requires MOBILEMCP_AUTH in Bearer token format.");
			process.exit(1);
		}

		const extraHosts = hostnames.map(hostname => hostname.toLowerCase());
		const allowedHosts = [...new Set([...loopbackHosts, ...extraHosts])];
		const privateOrigins = new Set(extraHosts.map(hostname => `https://${hostname}`));
		app = createMcpExpressApp({ host, allowedHosts, allowedOrigins: allowedHosts });
		app.use((req, res, next) => {
			const origin = req.headers.origin;
			// The SDK checks hostnames. Restrict newly allowed browser origins to HTTPS on port 443.
			if (origin === undefined || privateOrigins.has(origin) || validateOriginHeader(origin, loopbackHosts).ok) {
				next();
				return;
			}
			res.status(403).json({ error: "Invalid Origin" });
		});
	}

	// Migration hint for clients still pointing at the removed SSE transport.
	// Registered before auth so unauthenticated clients see the reason, not a 401.
	app.all("/sse", (_req: Request, res: Response) => {
		res.status(410).json({
			jsonrpc: "2.0",
			error: {
				code: -32000,
				message: "SSE transport removed. mobile-mcp now serves MCP Streamable HTTP at /mcp. See https://github.com/mobile-next/mobile-mcp#streamable-http-server-mode",
			},
			id: null,
		});
	});

	if (!authToken) {
		error("WARNING: MOBILEMCP_AUTH is not set. The HTTP server will accept unauthenticated connections. Set MOBILEMCP_AUTH to require Bearer token authentication.");
	}

	if (authToken) {
		app.use((req, res, next) => {
			if (req.headers.authorization !== `Bearer ${authToken}`) {
				res.status(401).json({ error: "Unauthorized" });
				return;
			}

			next();
		});
	}

	// createMcpHandler serves both protocol eras from one factory: requests
	// carrying the per-request `_meta` envelope (revision 2026-07-28, answered
	// with `server/discover` and the modern result vocabulary) get a fresh
	// era-marked instance, and legacy `initialize` traffic is served stateless
	// from the same factory — the same per-request model as before.
	// onerror keeps request-handling and transport failures in the application
	// log (the SDK otherwise answers HTTP 500 silently).
	const handler = createMcpHandler(() => createMcpServer(), { onerror: logMcpError });
	const node = toNodeHandler(handler, { onerror: logMcpError });

	app.post("/mcp", (req: Request, res: Response) => {
		void node(req, res, req.body);
	});

	// Stateless mode has no long-lived sessions; GET (SSE stream) and DELETE
	// (session teardown) are not applicable. Return 405 per SDK guidance.
	const methodNotAllowed = (_req: Request, res: Response) => {
		res.status(405).json({
			jsonrpc: "2.0",
			error: {
				code: -32000,
				message: "Method not allowed.",
			},
			id: null,
		});
	};

	app.get("/mcp", methodNotAllowed);
	app.delete("/mcp", methodNotAllowed);

	const server = createServer((req, res) => {
		const invalidRequest = originFormTarget.test(req.url ?? "") ? invalidHttpHeader(req) : "Invalid request target";
		if (invalidRequest) {
			res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: invalidRequest }));
			return;
		}
		app(req, res);
	});

	// Node dispatches CONNECT separately from ordinary HTTP requests.
	server.on("connect", (_req, socket) => {
		const destroy = () => socket.destroy();
		// Bound the write even if the peer keeps its side open or the response cannot flush.
		const deadline = setTimeout(destroy, 1000).unref();
		socket.once("close", () => clearTimeout(deadline));
		socket.once("error", destroy);
		socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", destroy);
	});

	// In whitelist mode use a numeric bind address even when --listen defaults to localhost.
	const bindHost = configuredHosts !== undefined && host === "localhost" ? "127.0.0.1" : host;
	const displayHost = isIP(bindHost) === 6 ? `[${bindHost}]` : bindHost;
	server.once("error", (err: NodeJS.ErrnoException) => {
		error(`Mobile MCP HTTP listen failed (${err.code ?? "unknown error"}).`);
		process.exitCode = 1;
	});
	server.listen(port, bindHost, () => {
		error(`mobile-mcp ${getAgentVersion()} streamable http server listening on http://${displayHost}:${port}/mcp`);
	});
};

const startStdioServer = async () => {
	try {
		// serveStdio owns the transport and the era decision for the
		// connection: a `server/discover` probe (revision 2026-07-28) pins
		// the connection modern, while an `initialize` handshake keeps
		// serving the 2025-era protocol exactly as before. The factory runs
		// lazily on the first message, so a failing createMcpServer() surfaces
		// through onerror rather than the catch below.
		serveStdio(() => createMcpServer(), { onerror: logMcpError });

		// Exit cleanly on termination signals so node flushes pending work
		// (including NODE_V8_COVERAGE output). Node's default SIGINT/SIGTERM
		// handling terminates the process without writing the coverage file,
		// which makes the `test:mcp` report come back all zeros.
		const shutdown = () => {
			process.exit(0);
		};

		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);

		error(`mobile-mcp ${getAgentVersion()} (mcp sdk ${getSdkVersion()}) server running on stdio`);
	} catch (err: any) {
		console.error("Fatal error in main():", err);
		error("Fatal error in main(): " + JSON.stringify(err.stack));
		process.exit(1);
	}
};

const installIntoDetectedClients = async (options: InstallOptions) => {
	// add-mcp is ESM-only, loaded lazily so a normal server start does not pay for it
	const { agents, detectGlobalAgents, upsertServer } = await import("add-mcp");
	const prompts = await import("@clack/prompts");
	const config = { command: "npx", args: ["-y", "@mobilenext/mobile-mcp@latest"] };
	const detected = await detectGlobalAgents();
	if (detected.length === 0) {
		console.log("No MCP clients detected. See https://github.com/mobile-next/mobile-mcp#installation-and-configuration");
		return;
	}

	// no terminal to draw checkboxes on (e.g. an agent ran us), so behave like --yes
	let selected = detected;
	if (!options.yes && process.stdin.isTTY) {
		const answer = await prompts.multiselect({
			message: "Install mobile-mcp into which clients?",
			options: detected.map(agent => ({ value: agent, label: agents[agent].displayName })),
			initialValues: detected,
			required: false,
		});
		if (prompts.isCancel(answer)) {
			prompts.cancel("Installation cancelled.");
			return;
		}

		selected = answer;
	}

	for (const agent of selected) {
		const result = upsertServer(agent, "mobile-mcp", config);
		if (result.success) {
			console.log(`✓ ${agents[agent].displayName}: ${result.path}`);
		} else {
			console.log(`✗ ${agents[agent].displayName}: ${result.error}`);
			process.exitCode = 1;
		}
	}
};

const startServer = async () => {
	const options = program.opts();

	if (options.listen !== undefined) {
		const listen = options.listen as string;
		const lastColon = listen.lastIndexOf(":");
		let host = "localhost";
		let rawPort: string;

		if (lastColon > 0) {
			host = listen.substring(0, lastColon);
			rawPort = listen.substring(lastColon + 1);
		} else {
			rawPort = listen;
		}

		if (host === "[::1]") {
			host = "::1";
		}
		const port = parsePort(rawPort);
		if (port === undefined) {
			error(`Invalid --listen value "${listen}". Expected [host:]port with port 1-65535.`);
			process.exit(1);
		}

		await startHttpServer(host, port);
	} else {
		await startStdioServer();
	}
};

const main = async () => {
	program
		.version(getAgentVersion())
		.option("--listen <listen>", "Start Streamable HTTP server on [host:]port")
		.option("--stdio", "Start stdio server (default)")
		.action(startServer);

	program
		.command("install")
		.description("Add mobile-mcp to the MCP clients detected on this machine")
		.option("-y, --yes", "Install into every detected client without asking")
		.action(installIntoDetectedClients);

	await program.parseAsync(process.argv);
};

main().then();
