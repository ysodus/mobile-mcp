import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { request } from "node:http";
import { createConnection, createServer } from "node:net";
import { resolve } from "node:path";

const privateHost = "ss-macbook-air.tailf25270.ts.net";
const token = randomUUID() + "._~+/=";
const initialize = {
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-11-25",
		capabilities: {},
		clientInfo: { name: "allowlist-test", version: "1.0.0" },
	},
};
type SocketObservation = "close" | "stall";

const start = (args: string[], hosts?: string, auth: string | null = token, observe?: SocketObservation) => {
	const env: NodeJS.ProcessEnv = { ...process.env, MOBILEMCP_DISABLE_TELEMETRY: "1" };
	delete env.MOBILEMCP_ALLOWED_HOSTS;
	delete env.MOBILEMCP_AUTH;
	if (hosts !== undefined) {
		env.MOBILEMCP_ALLOWED_HOSTS = hosts;
	}
	if (auth !== null) {
		env.MOBILEMCP_AUTH = auth;
	}
	// Exit through Node so V8 writes coverage even when the test stops the HTTP server.
	const setup = `
		process.once("SIGTERM", () => process.exit(0));
		${observe ? `
			require("node:diagnostics_channel").subscribe("net.server.socket", ({ socket }) => {
				socket.once("close", () => process.stderr.write("Test server socket closed\\n"));
				if (${observe === "stall"}) {
					socket.end = function () {
						process.stderr.write("Test server socket write stalled\\n");
						return this;
					};
				}
			});
		` : ""}
		require(process.argv[1]);
	`;
	const child = spawn(process.execPath, ["-e", setup, "--", resolve("lib/index.js"), ...args], { env });
	let exited = false;
	const closed = once(child, "close").then(result => {
		exited = true;
		return result;
	});
	let stderr = "";
	let stdout = "";
	child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
	child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
	return { child, closed, exited: () => exited, stderr: () => stderr, stdout: () => stdout };
};

const isolatedPort = async (address = "127.0.0.1") => {
	const socket = createServer().listen(0, address);
	await once(socket, "listening");
	const bound = socket.address();
	if (!bound || typeof bound === "string") {
		throw new Error("No test TCP address");
	}
	await new Promise<void>((resolve, reject) => socket.close(err => err ? reject(err) : resolve()));
	return bound.port;
};

const withHttpServer = async (
	hosts: string | undefined,
	run: (port: number, server: ReturnType<typeof start>) => Promise<void>,
	address = "127.0.0.1",
	observe?: SocketObservation,
) => {
	for (let attempt = 0; attempt < 3; attempt++) {
		const port = await isolatedPort(address);
		const host = address === "::1" ? "[::1]" : address;
		const server = start(["--listen", `${host}:${port}`], hosts, token, observe);
		const ready = `listening on http://${host}:${port}/mcp`;
		try {
			await expect.poll(() => server.stderr().includes(ready) || server.exited()).toBe(true);
			if (server.stderr().includes("listen failed (EADDRINUSE)")) {
				continue;
			}
			expect(server.stderr()).toContain(ready);
			await run(port, server);
			return;
		} finally {
			server.child.kill();
			await server.closed;
		}
	}
	throw new Error("Could not bind a test port after three attempts");
};

const post = (
	port: number,
	host: string,
	headers: Record<string, string | undefined> = {},
	body: object = initialize,
	address = "127.0.0.1",
) =>
	new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
		const req = request({
			hostname: address,
			port,
			path: "/mcp",
			method: "POST",
			headers: {
				"host": host,
				"content-type": "application/json",
				"accept": "application/json, text/event-stream",
				...Object.fromEntries(Object.entries({ authorization: `Bearer ${token}`, ...headers })
					.filter(([, value]) => value !== undefined)),
			},
		}, res => {
			let body = "";
			res.setEncoding("utf8").on("data", chunk => { body += chunk; });
			res.on("end", () => resolve({ status: res.statusCode, body }));
			res.on("error", reject);
		});
		req.setTimeout(5000, () => req.destroy(new Error("MCP request timed out")));
		req.on("error", reject);
		req.end(JSON.stringify(body));
	});

const parseResponse = (body: string) => {
	const data = body.split("\n").find(line => line.startsWith("data: "));
	return JSON.parse(data ? data.slice(6) : body);
};

const expectInitialize = (body: string) => {
	expect(parseResponse(body)).toMatchObject({
		jsonrpc: "2.0",
		id: 1,
		result: {
			protocolVersion: "2025-11-25",
			serverInfo: { name: "mobile-mcp" },
			capabilities: { tools: expect.any(Object) },
		},
	});
};

const expectToolsList = async (port: number, host: string, address?: string) => {
	const response = await post(port, host, { "mcp-protocol-version": "2025-11-25" }, {
		jsonrpc: "2.0",
		id: 2,
		method: "tools/list",
		params: {},
	}, address);
	expect(response.status).toBe(200);
	expect(parseResponse(response.body)).toMatchObject({
		jsonrpc: "2.0",
		id: 2,
		result: {
			tools: expect.arrayContaining([expect.objectContaining({ name: "mobile_list_available_devices" })]),
		},
	});
};

test("keeps the default loopback Host and Origin policy", async () => {
	await withHttpServer(undefined, async port => {
		const response = await post(port, `127.0.0.1:${port}`, { origin: `http://127.0.0.1:${port}` });
		expect(response.status).toBe(200);
		expectInitialize(response.body);
		await expectToolsList(port, "localhost");
		const auth = `Authorization: Bearer ${token}`;
		expect(await rawRequest(port, ["Host: localhost", "Host: localhost", auth])).toBe(400);
		expect(await rawRequest(port, ["Host: localhost", "Origin: https://localhost/path", auth])).toBe(400);
		expect((await post(port, privateHost)).status).toBe(403);
		expect((await post(port, "localhost", { origin: "https://evil.example" })).status).toBe(403);
		expect((await post(port, "localhost", { authorization: undefined })).status).toBe(401);
	});
});

test("adds only exact trusted Hosts and HTTPS Origins while still requiring auth", async () => {
	await withHttpServer(` ${privateHost.toUpperCase()} , ${privateHost}, second.example `, async port => {
		const allowed: [string, string?][] = [
			[privateHost],
			[`${privateHost.toUpperCase()}:443`, `https://${privateHost}`],
			["second.example"],
			["localhost", "http://localhost:65535"],
			["127.0.0.1:1", "https://127.0.0.1"],
		];
		for (const [host, origin] of allowed) {
			const response = await post(port, host, { origin });
			expect(response.status).toBe(200);
			expectInitialize(response.body);
		}
		await expectToolsList(port, privateHost);
		for (const host of ["evil.example", `prefix.${privateHost}`, `${privateHost}.evil.example`]) {
			expect((await post(port, host)).status).toBe(403);
		}
		for (const origin of ["https://evil.example", `https://${privateHost}.evil.example`, `http://${privateHost}`, `https://${privateHost}:444`]) {
			expect((await post(port, privateHost, { origin })).status).toBe(403);
		}
		for (const authorization of [undefined, "Bearer wrong"]) {
			expect((await post(port, privateHost, { authorization })).status).toBe(401);
		}
		const forwarded = {
			"forwarded": `host=${privateHost};proto=https`,
			"x-forwarded-host": privateHost,
			"x-forwarded-proto": "https",
		};
		expect((await post(port, "evil.example", forwarded)).status).toBe(403);
		expect((await post(port, privateHost, { ...forwarded, origin: "https://evil.example" })).status).toBe(403);
		expect((await post(port, privateHost, { ...forwarded, authorization: undefined })).status).toBe(401);
	});
});

const expectStartupError = async (listen: string, auth: string | null, message: string) => {
	const server = start(["--listen", listen], privateHost, auth);
	try {
		await expect.poll(server.stderr).toContain(message);
		expect(await server.closed).toEqual([1, null]);
		expect(server.stderr()).not.toContain("listening on");
		if (auth && auth.trim() && auth !== token) {
			expect(server.stderr()).not.toContain(auth);
		}
	} finally {
		server.child.kill();
		await server.closed;
	}
};

test("rejects invalid HTTP configuration before listening", async () => {
	const port = await isolatedPort();
	const listen = `127.0.0.1:${port}`;
	const invalidHosts = [
		"", " ", "*", "*.tailf25270.ts.net", ".tailf25270.ts.net",
		`https://${privateHost}`, `${privateHost}/mcp`, `user@${privateHost}`, `${privateHost}:443`,
		`${privateHost},`, `${privateHost}.`, "a..example", "a_b.example", "a.Kexample", `${"a".repeat(64)}.example`,
	];
	for (const value of invalidHosts) {
		const server = start(["--listen", listen], value);
		try {
			await expect.poll(server.stderr).toContain("Invalid MOBILEMCP_ALLOWED_HOSTS");
			expect(await server.closed).toEqual([1, null]);
		} finally {
			server.child.kill();
			await server.closed;
		}
	}
	const invalidListen = ["", "0", "65536", "123abc", "+123", "1.5", " 123", "123 ", "127.0.0.1:", ":123"];
	for (const address of invalidListen) {
		await expectStartupError(address, token, "Invalid --listen value");
	}
	for (const address of [`0.0.0.0:${port}`, `:::${port}`, `127.1:${port}`]) {
		await expectStartupError(address, token, "requires a loopback");
	}
	for (const auth of [null, "", " ", "bad token", "bad\ttoken", "bad\ntoken", "bad:token", "bad=token", "=only"]) {
		await expectStartupError(listen, auth, "requires MOBILEMCP_AUTH in Bearer token format");
	}
});

test("stdio initialize ignores HTTP-only configuration", async () => {
	const server = start(["--stdio"], "*", null);
	try {
		server.child.stdin.write(JSON.stringify(initialize) + "\n");
		await expect.poll(server.stdout).toContain("\n");
		expectInitialize(server.stdout().trim());
	} finally {
		server.child.kill();
		await server.closed;
	}
});

const rawRequest = (port: number, headers: string[], method = "POST", target = "/mcp") =>
	new Promise<number>((resolve, reject) => {
		const body = method === "POST" ? JSON.stringify(initialize) : "";
		const socket = createConnection(port, "127.0.0.1", () => {
			socket.write([
				`${method} ${target} HTTP/1.1`,
				"Connection: close",
				"Content-Type: application/json",
				"Accept: application/json, text/event-stream",
				`Content-Length: ${Buffer.byteLength(body)}`,
				...headers,
				"",
				body,
			].join("\r\n"));
		});
		let response = "";
		socket.setEncoding("utf8").on("data", chunk => {
			response += chunk;
			const status = /^HTTP\/1\.1 (\d{3}) /.exec(response);
			if (status) {
				resolve(Number(status[1]));
				socket.destroy();
			}
		});
		socket.setTimeout(5000, () => socket.destroy(new Error("Raw MCP request timed out")));
		socket.on("error", reject);
		socket.on("end", () => reject(new Error("Missing HTTP status line")));
	});

test("rejects ambiguous or malformed raw Host fields before URL normalization", async () => {
	await withHttpServer(privateHost, async port => {
		const validHost = `Host: ${privateHost}`;
		const invalidHeaders = [
			[validHost, "Host: evil.example"],
			["Host: evil.example", validHost],
			[validHost, validHost],
			...["/extra", ":", ":0", ":65536", "?q", "#fragment", "\\extra", ",evil.example"]
				.map(suffix => [`Host: ${privateHost}${suffix}`]),
			...[`%73${privateHost.slice(1)}`, `evil.example@${privateHost}`, "127.1", "0x7f000001", "0177.0.0.1", "::1"]
				.map(host => [`Host: ${host}`]),
		];
		for (const headers of invalidHeaders) {
			expect(await rawRequest(port, [...headers, `Authorization: Bearer ${token}`]), headers.join(" | ")).toBe(400);
		}
	});
});

test("rejects ambiguous or malformed raw Origin fields before URL normalization", async () => {
	await withHttpServer(privateHost, async port => {
		const validOrigin = "Origin: https://localhost";
		const invalidHeaders = [
			[validOrigin, validOrigin],
			["Origin: https://localhost/path", "Origin: https://evil.example"],
			["Origin: https://evil.example", validOrigin],
			[`Origin: https://${privateHost}`, `Origin: https://${privateHost}`],
			...["", "null", "https://localhost/path", "https://evil.example@localhost", "https://localhost?q",
				"https://localhost#fragment", "https://localhost, https://evil.example", "https://localhost/",
				"https://localhost:", "ftp://localhost", "https://127.1", "https://localhost\\path"]
				.map(origin => [`Origin: ${origin}`]),
		];
		for (const headers of invalidHeaders) {
			expect(await rawRequest(port, [`Host: ${privateHost}`, ...headers, `Authorization: Bearer ${token}`]), headers.join(" | ")).toBe(400);
		}
	});
});

test("accepts origin-form MCP requests and rejects absolute-form targets before routing", async () => {
	await withHttpServer(privateHost, async port => {
		const auth = `Authorization: Bearer ${token}`;
		const headers = [`Host: ${privateHost}`, auth];
		const response = await post(port, privateHost);
		expect(response.status).toBe(200);
		expectInitialize(response.body);
		expect(await rawRequest(port, headers)).toBe(200);
		expect(await rawRequest(port, headers, "POST", "/mcp?next=https%3A%2F%2Fevil.example?x=1")).toBe(200);
		expect(await rawRequest(port, headers, "POST", "/%2Fevil.example/mcp")).toBe(404);
		expect(await rawRequest(port, [headers[0]])).toBe(401);
		expect(await rawRequest(port, ["Host: evil.example", auth])).toBe(403);

		const targets = [
			"http://evil.example/mcp", `https://${privateHost}/mcp`,
			`http://evil.example@${privateHost}/mcp`, `http://${privateHost}@evil.example/mcp`,
			`http://%73${privateHost.slice(1)}/mcp`, `http://${privateHost}%3A443/mcp`,
			`http://${privateHost}:/mcp`, `http://${privateHost}:443/mcp`,
			`http://${privateHost}:65536/mcp`, "http://[::1]:443/mcp",
		];
		for (const target of targets) {
			expect(await rawRequest(port, headers, "POST", target), target).toBe(400);
		}
		expect(await rawRequest(port, ["Host: evil.example", auth], "POST", targets[1])).toBe(400);
	});
});

test("rejects other request-target forms with or without the private allowlist", async () => {
	for (const hosts of [undefined, privateHost]) {
		await withHttpServer(hosts, async port => {
			const headers = ["Host: localhost", `Authorization: Bearer ${token}`];
			expect(await rawRequest(port, headers, "POST", "http://localhost/mcp")).toBe(400);
			for (const target of ["//evil.example/mcp", "/\\evil.example/mcp", "/mcp#fragment", "/mcp?bad=%2", "mcp"]) {
				expect(await rawRequest(port, headers, "POST", target), target).toBe(400);
			}
			expect(await rawRequest(port, headers, "OPTIONS", "*")).toBe(400);
			expect(await rawRequest(port, headers, "CONNECT", "localhost:443")).toBe(400);
		});
	}
});

const connectRequest = `CONNECT evil.example:443 HTTP/1.1\r\nHost: ${privateHost}\r\n\r\n`;

test("releases rejected CONNECT sockets while unauthenticated clients keep writing enabled", async () => {
	await withHttpServer(privateHost, async (port, server) => {
		const clients = Array.from({ length: 4 }, () => createConnection({ host: "127.0.0.1", port, allowHalfOpen: true }));
		try {
			const responses = await Promise.all(clients.map(socket => new Promise<string>((resolve, reject) => {
				let response = "";
				socket.once("connect", () => socket.write(connectRequest));
				socket.setTimeout(5000, () => socket.destroy(new Error("CONNECT response timed out")));
				socket.on("error", reject);
				socket.on("end", () => reject(new Error("CONNECT response ended before the HTTP headers")));
				socket.setEncoding("utf8").on("data", chunk => {
					response += chunk;
					if (response.includes("\r\n\r\n")) {
						socket.setTimeout(0);
						resolve(response);
					}
				});
			})));
			for (const response of responses) {
				expect(response).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
			}
			await expect.poll(() => server.stderr().match(/Test server socket closed/g)?.length ?? 0, { timeout: 2500 })
				.toBe(clients.length);
			expect(clients.every(socket => !socket.writableEnded && !socket.destroyed)).toBe(true);
		} finally {
			clients.forEach(socket => socket.destroy());
		}
	}, "127.0.0.1", "close");
});

test("bounds stalled CONNECT responses and survives a client reset", async () => {
	await withHttpServer(privateHost, async (port, server) => {
		const clients = Array.from({ length: 2 }, () => createConnection({ host: "127.0.0.1", port, allowHalfOpen: true }));
		try {
			await Promise.all(clients.map(async socket => {
				await once(socket, "connect");
				socket.on("error", () => {});
				socket.write(connectRequest);
			}));
			await expect.poll(() => server.stderr().match(/Test server socket write stalled/g)?.length ?? 0).toBe(clients.length);
			clients[0].resetAndDestroy();
			await expect.poll(() => server.stderr().match(/Test server socket closed/g)?.length ?? 0, { timeout: 2500 })
				.toBe(clients.length);
			expect(clients[1].writableEnded).toBe(false);
			expect(server.exited()).toBe(false);
		} finally {
			clients.forEach(socket => socket.destroy());
		}
	}, "127.0.0.1", "stall");
});

test("accepts canonical IPv6 loopback Host and Origin over an IPv6 loopback listener", async () => {
	await withHttpServer(privateHost, async port => {
		const response = await post(port, `[::1]:${port}`, { origin: `http://[::1]:${port}` }, initialize, "::1");
		expect(response.status).toBe(200);
		expectInitialize(response.body);
		await expectToolsList(port, privateHost, "::1");
	}, "::1");
});

test("applies the same header and auth checks to every MCP HTTP method", async () => {
	await withHttpServer(privateHost, async port => {
		const host = `Host: ${privateHost}`;
		const authorization = `Authorization: Bearer ${token}`;
		for (const method of ["POST", "GET", "HEAD", "DELETE", "OPTIONS", "PUT", "PATCH"]) {
			expect(await rawRequest(port, [host, host, authorization], method), method).toBe(400);
			expect(await rawRequest(port, [host, "Origin: https://localhost/path", authorization], method), method).toBe(400);
			expect(await rawRequest(port, ["Host: evil.example", `X-Forwarded-Host: ${privateHost}`, authorization], method), method).toBe(403);
			expect(await rawRequest(port, [host, "Origin: https://evil.example", authorization], method), method).toBe(403);
			expect(await rawRequest(port, [host], method), method).toBe(401);
		}
		for (const method of ["GET", "HEAD", "DELETE"]) {
			expect(await rawRequest(port, [host, authorization], method), method).toBe(405);
		}
	});
});

test("reports a busy loopback port without advertising a listener", async () => {
	const occupied = createServer().listen(0, "127.0.0.1");
	try {
		await once(occupied, "listening");
		const address = occupied.address();
		if (!address || typeof address === "string") {
			throw new Error("No occupied test TCP address");
		}
		await expectStartupError(`127.0.0.1:${address.port}`, token, "listen failed (EADDRINUSE)");
	} finally {
		await new Promise<void>((resolve, reject) => occupied.close(err => err ? reject(err) : resolve()));
	}
});
