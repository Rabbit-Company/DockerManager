import { expect, test } from "bun:test";
import { checkCompose, checkStackName, COMPOSE_TEMPLATE, envChanges, hasErrors, parseEnv } from "../src/shared/compose.ts";
import { diffLines, hunks } from "../src/shared/diff.ts";

const messages = (source: string) => checkCompose(source).map((i) => `${i.severity}:${i.line}:${i.message}`);

test("the template is a valid file", () => {
	expect(checkCompose(COMPOSE_TEMPLATE)).toEqual([]);
});

test("broken YAML and missing services are errors", () => {
	expect(hasErrors(checkCompose("services: [\n"))).toBe(true);
	expect(messages("name: x\n")).toEqual(["error:1:Add at least one service under services."]);
	expect(messages("- a\n- b\n")[0]).toStartWith("error:1:A compose file is a map");
	expect(hasErrors(checkCompose("services:\n  a:\n    image: x\n  a:\n    image: y\n"))).toBe(true);
});

test("references must point to something declared", () => {
	const source = `services:
  web:
    image: nginx
    ports: ["8080:80", "bad port", 80, "127.0.0.1:53:53/udp", "\${PORT}:80"]
    volumes: ["data:/x", "./local:/y", "/abs:/z", "missing:/m"]
    depends_on: [db]
    networks: [front, default]
  job:
    restart: always
volumes:
  data:
foo: 1
`;
	expect(messages(source)).toEqual([
		'error:4:"bad port" is not a port mapping. Use "8080:80", "127.0.0.1:8080:80" or "80".',
		'error:5:Volume "missing" is used here but not declared under the top level volumes key.',
		'error:6:Service "web" depends on "db", which does not exist.',
		'error:7:Network "front" is used here but not declared under the top level networks key.',
		'error:8:Service "job" needs an image or a build section.',
		'warning:12:Unknown top level key "foo". Compose ignores it or refuses the file.',
	]);
});

test("extension keys and long volume syntax are fine", () => {
	const source = `x-common: &c
  restart: unless-stopped
services:
  app:
    <<: *c
    build: .
    volumes:
      - type: volume
        source: cache
        target: /cache
volumes:
  cache: {}
`;
	expect(checkCompose(source)).toEqual([]);
});

test("stack names are compose project names", () => {
	expect(checkStackName(" Shop ")).toEqual({ ok: true, value: "shop" });
	expect(checkStackName("my_app-2").ok).toBe(true);
	expect(checkStackName("-bad").ok).toBe(false);
	expect(checkStackName("a".repeat(64)).ok).toBe(false);
});

test("env files are read like compose reads them", () => {
	const { entries, errors } = parseEnv("# comment\nA=1\nexport B = two\n\nnot a line\nC=\n");
	expect(entries).toEqual([
		{ key: "A", value: "1" },
		{ key: "B", value: "two" },
		{ key: "C", value: "" },
	]);
	expect(errors).toEqual([{ line: 5, message: "Line 5 is not KEY=value." }]);
	expect(envChanges("A=1\nB=2\n", "A=1\nB=3\nC=4\n")).toEqual({ added: ["C"], removed: [], changed: ["B"] });
});

test("line diffs and hunks", () => {
	const lines = diffLines("a\nb\nc\n", "a\nx\nc\nd\n");
	expect(lines.map((l) => `${l.kind}:${l.text}`)).toEqual(["same:a", "del:b", "add:x", "same:c", "add:d"]);
	const long = Array.from({ length: 20 }, (_, i) => String(i)).join("\n");
	const changed = long.replace("10", "ten");
	const parts = hunks(diffLines(long, changed), 2);
	expect(parts).toHaveLength(1);
	expect(parts[0]!.lines.map((l) => l.text)).toEqual(["8", "9", "10", "ten", "11", "12"]);
	expect(hunks(diffLines(long, long))).toEqual([]);
});
