import { expect, test } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { request } from "node:http";
import { createServer } from "node:net";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const privateHost = "ss-macbook-air.tailf25270.ts.net";
const token = randomUUID();
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
let stageDir: string;

test.beforeAll(() => {
	stageDir = mkdtempSync(resolve("test-results", "allowlist-"));
	copyFileSync("package.json", join(stageDir, "package.json"));
	execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "--outDir", join(stageDir, "lib")]);
});

test.afterAll(() => {
	if (stageDir) {
		rmSync(stageDir, { recursive: true, force: true });
	}
});

const start = (args: string[], hosts?: string, authenticate = true) => {
	const env: NodeJS.ProcessEnv = { ...process.env, MOBILEMCP_DISABLE_TELEMETRY: "1" };
	delete env.MOBILEMCP_ALLOWED_HOSTS;
	delete env.MOBILEMCP_AUTH;
	if (hosts !== undefined) {
		env.MOBILEMCP_ALLOWED_HOSTS = hosts;
	}
	if (authenticate) {
		env.MOBILEMCP_AUTH = token;
	}
	const child = spawn(process.execPath, [join(stageDir, "lib", "index.js"), ...args], { env });
	let stderr = "";
	let stdout = "";
	child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
	child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
	return { child, closed: once(child, "close"), stderr: () => stderr, stdout: () => stdout };
};

const isolatedPort = async () => {
	const socket = createServer().listen(0, "127.0.0.1");
	await once(socket, "listening");
	const address = socket.address();
	if (!address || typeof address === "string") {
		throw new Error("No test TCP address");
	}
	await new Promise<void>((resolve, reject) => socket.close(err => err ? reject(err) : resolve()));
	return address.port;
};

const withHttpServer = async (hosts: string | undefined, run: (port: number) => Promise<void>) => {
	const port = await isolatedPort();
	const server = start(["--listen", `127.0.0.1:${port}`], hosts);
	try {
		await expect.poll(server.stderr).toContain(`listening on http://127.0.0.1:${port}/mcp`);
		await run(port);
	} finally {
		server.child.kill();
		await server.closed;
	}
};

const post = (port: number, host: string, headers: Record<string, string | undefined> = {}) =>
	new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
		const req = request({
			hostname: "127.0.0.1",
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
		req.end(JSON.stringify(initialize));
	});

const expectInitialize = (body: string) => {
	const data = body.split("\n").find(line => line.startsWith("data: "));
	expect(JSON.parse(data ? data.slice(6) : body)).toMatchObject({
		jsonrpc: "2.0",
		id: 1,
		result: {
			protocolVersion: "2025-11-25",
			serverInfo: { name: "mobile-mcp" },
			capabilities: { tools: expect.any(Object) },
		},
	});
};

test("keeps the default loopback Host and Origin policy", async () => {
	await withHttpServer(undefined, async port => {
		const response = await post(port, `127.0.0.1:${port}`, { origin: `http://127.0.0.1:${port}` });
		expect(response.status).toBe(200);
		expectInitialize(response.body);
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
			["localhost"],
		];
		for (const [host, origin] of allowed) {
			const response = await post(port, host, { origin });
			expect(response.status).toBe(200);
			expectInitialize(response.body);
		}
		for (const host of ["evil.example", `prefix.${privateHost}`, `${privateHost}.evil.example`]) {
			expect((await post(port, host)).status).toBe(403);
		}
		for (const origin of ["https://evil.example", `https://${privateHost}.evil.example`, `http://${privateHost}`, `https://${privateHost}:444`, "null", ""]) {
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
	for (const [address, authenticate, message] of [
		[`0.0.0.0:${port}`, true, "requires a loopback"],
		[listen, false, "requires MOBILEMCP_AUTH"],
	] as const) {
		const server = start(["--listen", address], privateHost, authenticate);
		try {
			await expect.poll(server.stderr).toContain(message);
			expect(await server.closed).toEqual([1, null]);
		} finally {
			server.child.kill();
			await server.closed;
		}
	}
});

test("stdio initialize ignores HTTP-only configuration", async () => {
	const server = start(["--stdio"], "*", false);
	try {
		server.child.stdin.write(JSON.stringify(initialize) + "\n");
		await expect.poll(server.stdout).toContain("\n");
		expectInitialize(server.stdout().trim());
	} finally {
		server.child.kill();
		await server.closed;
	}
});
