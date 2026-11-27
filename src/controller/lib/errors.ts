export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

export const notFound = (what = "Not found.") => new ApiError(404, "not_found", what);
export const badRequest = (message: string) => new ApiError(400, "bad_request", message);
export const forbidden = (message: string) => new ApiError(403, "forbidden", message);
export const unauthorized = (message = "Sign in first.") => new ApiError(401, "unauthorized", message);
export const tooMany = (message: string) => new ApiError(429, "too_many_requests", message);
