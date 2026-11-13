export class Counter {
  private value = 0;

  increment(by = 1): number {
    this.value += by;
    return this.value;
  }

  reset(): void {
    this.value = 0;
  }

  get current(): number {
    return this.value;
  }
}
