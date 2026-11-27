/** Enough of the S3 API for Bun.S3Client: single and multipart uploads, reads, deletes and ListObjectsV2. Signatures are not checked. */
export class FakeS3 {
	objects = new Map<string, Uint8Array>();
	private uploads = new Map<string, Map<number, Uint8Array>>();
	requests: string[] = [];
	private server: ReturnType<typeof Bun.serve>;

	constructor(readonly bucket = "backups") {
		this.server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => this.handle(req) });
	}

	get endpoint(): string {
		return `http://127.0.0.1:${this.server.port}`;
	}

	stop(): void {
		this.server.stop(true);
	}

	private async handle(req: Request): Promise<Response> {
		const url = new URL(req.url);
		this.requests.push(`${req.method} ${url.pathname}${url.search}`);
		const [, bucket, ...rest] = url.pathname.split("/");
		if (bucket !== this.bucket) return new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 });
		const key = decodeURIComponent(rest.join("/"));
		const q = url.searchParams;
		if (req.method === "GET" && key === "" && q.get("list-type") === "2") {
			const prefix = q.get("prefix") ?? "";
			const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
			const items = keys.map((k) => `<Contents><Key>${k}</Key><Size>${this.objects.get(k)!.length}</Size><ETag>"x"</ETag></Contents>`).join("");
			return new Response(
				`<?xml version="1.0"?><ListBucketResult><Name>${bucket}</Name><Prefix>${prefix}</Prefix><KeyCount>${keys.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${items}</ListBucketResult>`,
				{
					headers: { "Content-Type": "application/xml" },
				},
			);
		}
		if (req.method === "POST" && q.has("uploads")) {
			const id = crypto.randomUUID();
			this.uploads.set(id, new Map());
			return new Response(
				`<?xml version="1.0"?><InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
			);
		}
		if (req.method === "PUT" && q.has("uploadId")) {
			this.uploads.get(q.get("uploadId")!)!.set(Number(q.get("partNumber")), new Uint8Array(await req.arrayBuffer()));
			return new Response(null, { headers: { ETag: `"part${q.get("partNumber")}"` } });
		}
		if (req.method === "POST" && q.has("uploadId")) {
			const parts = this.uploads.get(q.get("uploadId")!)!;
			const ordered = [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
			this.objects.set(key, new Uint8Array(await new Blob(ordered as BlobPart[]).arrayBuffer()));
			this.uploads.delete(q.get("uploadId")!);
			return new Response(
				`<?xml version="1.0"?><CompleteMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><ETag>"done"</ETag></CompleteMultipartUploadResult>`,
			);
		}
		if (req.method === "DELETE" && q.has("uploadId")) {
			this.uploads.delete(q.get("uploadId")!);
			return new Response(null, { status: 204 });
		}
		if (req.method === "PUT") {
			this.objects.set(key, new Uint8Array(await req.arrayBuffer()));
			return new Response(null, { headers: { ETag: '"x"' } });
		}
		if (req.method === "GET" || req.method === "HEAD") {
			const body = this.objects.get(key);
			if (!body) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
			return new Response(req.method === "HEAD" ? null : (body as unknown as BodyInit), { headers: { "Content-Length": String(body.length) } });
		}
		if (req.method === "DELETE") {
			this.objects.delete(key);
			return new Response(null, { status: 204 });
		}
		return new Response("unsupported", { status: 501 });
	}
}
