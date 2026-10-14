import type { HttpClient } from "isomorphic-git";

/** Stream Git HTTP request chunks without a second complete upload buffer. */
export function gitHttp(fetcher: typeof fetch = fetch): HttpClient {
	return {
		async request({ url, method = "GET", headers = {}, body, signal, fetchOptions = {} }) {
			const input = body as AsyncIterable<Uint8Array> | Iterable<Uint8Array> | undefined;
			const iterator = input
				? Symbol.asyncIterator in input
					? input[Symbol.asyncIterator]()
					: input[Symbol.iterator]()
				: undefined;
			const stream = iterator
				? new ReadableStream<Uint8Array>(
						{
							async pull(controller) {
								try {
									const next = await iterator.next();
									if (next.done) controller.close();
									else controller.enqueue(next.value);
								} catch (error) {
									controller.error(error);
								}
							},
							async cancel() {
								await iterator.return?.();
							},
						},
						{ highWaterMark: 0 },
					)
				: undefined;
			let response: Response;
			try {
				const options: RequestInit & { duplex?: string } = {
					...fetchOptions,
					method,
					headers,
					body: stream,
					signal: signal ?? fetchOptions.signal,
					...(stream ? { duplex: "half" } : {}),
				};
				response = await fetcher(url, options);
			} catch (error) {
				await iterator?.return?.();
				throw error;
			}
			const responseBody = response.body;
			return {
				url: response.url,
				method,
				statusCode: response.status,
				statusMessage: response.statusText,
				headers: Object.fromEntries(response.headers.entries()),
				body: responseBody ? responseBody[Symbol.asyncIterator]() : (async function* () {})(),
			};
		},
	};
}
