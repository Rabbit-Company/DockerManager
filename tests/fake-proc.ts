import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A /proc and /sys tree on disk, with counters a test can move forward. */
export class FakeProc {
	readonly root = mkdtempSync(join(tmpdir(), "dm-proc-"));
	readonly proc = join(this.root, "proc");
	readonly sys = join(this.root, "sys");

	write(path: string, content: string): void {
		const full = join(this.root, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
	}

	host(o: { busy: number; idle: number; memTotalKb: number; memAvailableKb: number; rx: number; tx: number; readSectors: number; writeSectors: number }): void {
		const user = o.busy;
		this.write("proc/stat", `cpu  ${user} 0 0 ${o.idle} 0 0 0 0 0 0\ncpu0 0 0 0 0 0 0 0 0 0 0\ncpu1 0 0 0 0 0 0 0 0 0 0\nintr 1\n`);
		this.write("proc/meminfo", `MemTotal:       ${o.memTotalKb} kB\nMemFree:          1000 kB\nMemAvailable:   ${o.memAvailableKb} kB\n`);
		this.write("proc/loadavg", "0.52 0.40 0.30 1/200 1234\n");
		this.write(
			"proc/net/dev",
			`Inter-|   Receive\n face |bytes\n    lo: 999 0 0 0 0 0 0 0 999 0 0 0 0 0 0 0\n  eth0: ${o.rx} 0 0 0 0 0 0 0 ${o.tx} 0 0 0 0 0 0 0\ndocker0: 5000 0 0 0 0 0 0 0 5000 0 0 0 0 0 0 0\nveth12ab: 7000 0 0 0 0 0 0 0 7000 0 0 0 0 0 0 0\n`,
		);
		this.write(
			"proc/diskstats",
			`   8       0 sda 100 0 ${o.readSectors} 0 50 0 ${o.writeSectors} 0 0 0 0\n   8       1 sda1 100 0 999999 0 50 0 999999 0 0 0 0\n   7       0 loop0 1 0 888 0 0 0 888 0 0 0 0\n`,
		);
		mkdirSync(join(this.sys, "block", "sda"), { recursive: true });
		mkdirSync(join(this.sys, "block", "loop0"), { recursive: true });
		this.write(
			"proc/mounts",
			"/dev/sda1 / ext4 rw 0 0\nproc /proc proc rw 0 0\n/dev/sda1 /var/lib/docker btrfs rw 0 0\n/dev/sdb1 /mnt/backup\\040disk xfs rw 0 0\ntmpfs /run tmpfs rw 0 0\n",
		);
	}

	container(
		pid: number,
		cgroup: string,
		o: { usageUsec: number; memCurrent: number; inactive: number; max: string; rbytes: number; wbytes: number; rx: number; tx: number; pids: number },
	): void {
		this.write(`proc/${pid}/cgroup`, `0::${cgroup}\n`);
		const dir = `sys/fs/cgroup${cgroup}`;
		this.write(`${dir}/cpu.stat`, `usage_usec ${o.usageUsec}\nuser_usec 1\nsystem_usec 1\n`);
		this.write(`${dir}/memory.current`, `${o.memCurrent}\n`);
		this.write(`${dir}/memory.stat`, `anon 1\nfile 2\ninactive_file ${o.inactive}\n`);
		this.write(`${dir}/memory.max`, `${o.max}\n`);
		this.write(`${dir}/io.stat`, `8:0 rbytes=${o.rbytes} wbytes=${o.wbytes} rios=1 wios=1\n253:0 rbytes=0 wbytes=0\n`);
		this.write(`${dir}/pids.current`, `${o.pids}\n`);
		this.write(`proc/${pid}/net/dev`, `h\nh\n    lo: 100 0 0 0 0 0 0 0 100 0\n  eth0: ${o.rx} 0 0 0 0 0 0 0 ${o.tx} 0 0 0 0 0 0 0\n`);
	}

	cleanup(): void {
		rmSync(this.root, { recursive: true, force: true });
	}
}
