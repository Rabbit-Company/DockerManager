import { afterAll, expect, test } from "bun:test";
import { setFiring } from "../src/controller/alerts/state.ts";
import { getChannel, ruleSettings } from "../src/controller/db/alerts.ts";
import { FakeHttp } from "./fake-receivers.ts";
import { get, post, signIn, testApp } from "./helpers.ts";

const http = new FakeHttp();
afterAll(() => http.stop());

test("channels are added, tested and removed through the forms, and rules are saved", async () => {
	const { app } = testApp();
	const user = await signIn(app);
	const bad = await post(app, "/alerts/channels", { _csrf: user.csrf, name: "Hook", kind: "webhook", url: `${http.url}/in`, secret: "short" }, user.cookie);
	expect(bad.status).toBe(400);
	expect(await bad.text()).toContain("at least 16 characters");
	const res = await post(
		app,
		"/alerts/channels",
		{ _csrf: user.csrf, name: "Hook", kind: "webhook", url: `${http.url}/in`, secret: "a-long-shared-secret" },
		user.cookie,
	);
	expect(res.status).toBe(303);
	const id = Number(res.headers.get("Location")!.split("/").pop());
	await post(app, `/alerts/channels/${id}/test`, { _csrf: user.csrf }, user.cookie);
	expect(JSON.parse(http.received.at(-1)!.body)).toMatchObject({ event: "alert.test", alert: { title: "Alerts reach this channel" } });
	expect((await getChannel(id))!.lastSentAt).not.toBeNull();
	const page = await (await get(app, "/alerts", user.cookie)).text();
	expect(page).toContain("Firing now");
	expect(page).toContain("Hook");

	await post(
		app,
		"/alerts/rules",
		{
			_csrf: user.csrf,
			"enabled:host_cpu": "1",
			"threshold:host_cpu": "80",
			"minutes:host_cpu": "5",
			[`channel:host_cpu`]: String(id),
			"enabled:disk_full": "1",
		},
		user.cookie,
	);
	const settings = await ruleSettings();
	expect(settings.get("host_cpu")).toMatchObject({ enabled: true, threshold: 80, minutes: 5 });
	expect(settings.get("host_offline")!.enabled).toBe(false);
	expect(settings.get("disk_full")!.threshold).toBe(90);

	setFiring(3);
	expect(await (await get(app, "/", user.cookie)).text()).toContain('aria-label="3 alerts firing"');
	setFiring(0);

	await post(app, `/alerts/channels/${id}/delete`, { _csrf: user.csrf }, user.cookie);
	expect(await getChannel(id)).toBeNull();
});
