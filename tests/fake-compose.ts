import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Stands in for docker compose: prints its arguments, fails for projects named broken. */
export function fakeCompose(dir: string): string {
	const script = join(dir, "fake-compose.sh");
	writeFileSync(script, '#!/bin/sh\necho "compose $*"\ncase "$*" in *broken*) echo "service web failed to start" >&2; exit 1;; esac\nexit 0\n', {
		mode: 0o755,
	});
	return script;
}
