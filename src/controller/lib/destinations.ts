import type { DestinationConfig } from "../../shared/protocol.ts";
import { cleanText } from "../../shared/validate.ts";

export const KINDS: [DestinationConfig["kind"], string, string][] = [
	["s3", "S3 compatible storage", "AWS S3, Cloudflare R2, Backblaze B2, MinIO, Wasabi and others"],
	["local", "Folder on the host", "A disk of the host, or a share mounted there already"],
	["smb", "SMB share", "Windows shares and NAS devices, mounted only while a backup runs"],
	["nfs", "NFS export", "Mounted only while a backup runs"],
];

export type FormValues = Record<string, string>;

const field = (form: FormData, name: string) => {
	const v = form.get(name);
	return typeof v === "string" ? v.trim() : "";
};

/** What the form shows for an existing destination. Secrets are never sent back to the browser. */
export function formValues(config: DestinationConfig | null, name = ""): FormValues {
	const v: FormValues = { name, kind: config?.kind ?? "s3" };
	if (!config) return v;
	if (config.kind === "local") v.path = config.path;
	if (config.kind === "s3")
		Object.assign(v, { endpoint: config.endpoint, region: config.region, bucket: config.bucket, prefix: config.prefix ?? "", access_key: config.accessKeyId });
	if (config.kind === "smb")
		Object.assign(v, {
			share: config.share,
			smb_user: config.username,
			domain: config.domain ?? "",
			version: config.version ?? "",
			subfolder: config.path ?? "",
		});
	if (config.kind === "nfs") Object.assign(v, { export: config.export, options: config.options ?? "", subfolder: config.path ?? "" });
	return v;
}

/** Reads the destination form. A secret left empty keeps the one stored before. */
export function parseDestination(form: FormData, previous: DestinationConfig | null): { values: FormValues; config?: DestinationConfig; error?: string } {
	const values: FormValues = {};
	for (const key of [
		"name",
		"kind",
		"path",
		"endpoint",
		"region",
		"bucket",
		"prefix",
		"access_key",
		"share",
		"smb_user",
		"domain",
		"version",
		"export",
		"options",
		"subfolder",
	])
		values[key] = field(form, key);
	const name = cleanText(values.name!);
	if (name.length < 1 || name.length > 64) return { values, error: "Give the destination a name of 1 to 64 characters." };
	values.name = name;
	const subfolder = values.subfolder!.replace(/^\/+|\/+$/g, "");
	if (subfolder && (subfolder.split("/").includes("..") || !/^[\w./-]+$/.test(subfolder)))
		return { values, error: "The subfolder may hold letters, digits, dots, dashes and slashes." };
	const secret = (name: string, old: string | undefined) => field(form, name) || old || "";
	switch (values.kind) {
		case "local": {
			const path = values.path!.replace(/\/+$/, "");
			if (!path.startsWith("/") || path === "" || path.split("/").includes("..")) return { values, error: "Give an absolute folder, such as /mnt/backups." };
			return { values, config: { kind: "local", path } };
		}
		case "s3": {
			let endpoint = values.endpoint!.replace(/\/+$/, "");
			if (endpoint) {
				try {
					const url = new URL(endpoint);
					if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
					endpoint = url.origin;
				} catch {
					return { values, error: "The endpoint is an address like https://s3.eu-central-1.amazonaws.com." };
				}
			}
			if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(values.bucket!)) return { values, error: "Give the bucket name." };
			const old = previous?.kind === "s3" ? previous : null;
			const accessKeyId = values.access_key!;
			const secretAccessKey = secret("secret_key", old?.secretAccessKey);
			if (!accessKeyId || !secretAccessKey) return { values, error: "Give the access key and the secret key." };
			const prefix = values.prefix!.replace(/^\/+|\/+$/g, "");
			if (prefix && !/^[\w./-]+$/.test(prefix)) return { values, error: "The prefix may hold letters, digits, dots, dashes and slashes." };
			return { values, config: { kind: "s3", endpoint, region: values.region || "auto", bucket: values.bucket!, prefix, accessKeyId, secretAccessKey } };
		}
		case "smb": {
			if (!/^\/\/[\w.-]+\/[^\s,]+$/.test(values.share!)) return { values, error: "An SMB share looks like //server/share." };
			const old = previous?.kind === "smb" ? previous : null;
			const password = secret("smb_password", old?.password);
			if (!values.smb_user || !password) return { values, error: "Give the username and password of the share." };
			if (values.version && !/^[\d.]+$/.test(values.version)) return { values, error: "The SMB version is a number like 3.0." };
			return {
				values,
				config: {
					kind: "smb",
					share: values.share!,
					username: values.smb_user!,
					password,
					domain: values.domain || undefined,
					version: values.version || undefined,
					path: subfolder || undefined,
				},
			};
		}
		case "nfs": {
			if (!/^[\w.-]+:\/[^\s,]*$/.test(values.export!)) return { values, error: "An NFS export looks like server:/path." };
			if (values.options && !/^[\w=.,:-]+$/.test(values.options)) return { values, error: "The mount options have characters that are not allowed." };
			return { values, config: { kind: "nfs", export: values.export!, options: values.options || undefined, path: subfolder || undefined } };
		}
		default:
			return { values, error: "Choose a kind of destination." };
	}
}

export function describeDestination(config: DestinationConfig): string {
	switch (config.kind) {
		case "local":
			return config.path;
		case "s3":
			return `${config.bucket}${config.prefix ? `/${config.prefix}` : ""}${config.endpoint ? ` at ${new URL(config.endpoint).host}` : ""}`;
		case "smb":
			return `${config.share}${config.path ? `/${config.path}` : ""}`;
		case "nfs":
			return `${config.export}${config.path ? `/${config.path}` : ""}`;
	}
}
