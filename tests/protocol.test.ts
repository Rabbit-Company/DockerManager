import { expect, test } from "bun:test";
import { parseAgentMessage, parseBrowserMessage, parseControllerMessage } from "../src/shared/protocol.ts";

test("agent messages need a known type and the right fields", () => {
	expect(parseAgentMessage('{"type":"ping"}')).toEqual({ type: "ping" });
	expect(parseAgentMessage('{"type":"res","id":1,"ok":false,"error":"x"}')).not.toBeNull();
	expect(parseAgentMessage('{"type":"res","id":"1","ok":true}')).toBeNull();
	expect(parseAgentMessage('{"type":"snapshot","snapshot":{}}')).toBeNull();
	expect(parseAgentMessage('{"type":"req"}')).toBeNull();
	expect(parseAgentMessage("not json")).toBeNull();
	expect(parseAgentMessage("[]")).toBeNull();
});

test("controller messages", () => {
	expect(parseControllerMessage('{"type":"req","id":3,"method":"snapshot.refresh","params":{}}')).not.toBeNull();
	expect(parseControllerMessage('{"type":"req","id":3}')).toBeNull();
	expect(parseControllerMessage('{"type":"hello"}')).toBeNull();
});

test("browser messages are bounded", () => {
	expect(parseBrowserMessage('{"type":"watch","topics":["hosts","host:1"]}')).not.toBeNull();
	expect(parseBrowserMessage('{"type":"auth","csrf":"abcdefghijklmnopqrstuvwxyz012345"}')).not.toBeNull();
	expect(parseBrowserMessage(JSON.stringify({ type: "watch", topics: Array(51).fill("hosts") }))).toBeNull();
	expect(parseBrowserMessage('{"type":"logs.open","host":"1","container":"x","tail":5}')).toBeNull();
});
