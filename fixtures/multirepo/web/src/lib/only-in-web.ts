export function debounceInput(fn: (value: string) => void, waitMs: number): (value: string) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (value: string) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => fn(value), waitMs);
  };
}
