export class RingBuffer<T> {
  readonly #capacity: number;
  #items: T[] = [];
  #lastEvicted: T | undefined;

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  push(item: T): void {
    this.#items.push(item);
    if (this.#items.length > this.#capacity)
      this.#lastEvicted = this.#items.shift();
  }

  toArray(): T[] {
    return [...this.#items];
  }

  get lastEvicted(): T | undefined {
    return this.#lastEvicted;
  }
}
