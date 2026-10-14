/** One pending chunk; a producer cannot advance until the consumer takes it. */
export class BoundedPackFIFO {
	constructor(cancel = async () => {}) {
		this.cancel = cancel;
		this.ended = false;
		this.error = undefined;
		this.pending = undefined;
		this.reader = undefined;
		this.writer = undefined;
	}
	async write(value) {
		if (this.ended) throw this.error ?? Error("Pack stream is closed");
		if (this.pending !== undefined || this.writer) throw Error("Concurrent pack writes");
		if (this.reader) {
			const reader = this.reader;
			this.reader = undefined;
			reader.resolve({ value, done: false });
			return;
		}
		this.pending = value;
		await new Promise((resolve, reject) => {
			this.writer = { resolve, reject };
		});
	}
	async next() {
		if (this.error) throw this.error;
		if (this.pending !== undefined) {
			const value = this.pending;
			this.pending = undefined;
			this.writer?.resolve();
			this.writer = undefined;
			return { value, done: false };
		}
		if (this.ended) return { done: true };
		if (this.reader) throw Error("Concurrent pack reads");
		return new Promise((resolve, reject) => {
			this.reader = { resolve, reject };
		});
	}
	end() {
		this.ended = true;
		this.reader?.resolve({ done: true });
		this.reader = undefined;
	}
	destroy(error) {
		this.error = error;
		this.ended = true;
		this.pending = undefined;
		this.reader?.reject(error);
		this.writer?.reject(error);
		this.reader = this.writer = undefined;
	}
	async return() {
		this.destroy(Error("Pack consumer cancelled"));
		await this.cancel();
		return { done: true };
	}
	[Symbol.asyncIterator]() {
		return this;
	}
}
