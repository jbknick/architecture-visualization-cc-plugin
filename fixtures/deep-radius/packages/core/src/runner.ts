import { step3 } from "./step3";

export class Runner {
  helper(x: number): number {
    return step3(x) + 1;
  }

  alphaLow(x: number): number {
    return this.helper(x) + 1;
  }
}
