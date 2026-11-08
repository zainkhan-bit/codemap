import type { Config } from "../types";
import { util } from "../util";

interface Runner {
  run(): void;
}

export class Service implements Runner {
  constructor(private readonly config: Config) {}

  run(): void {
    this.helper();
    util();
  }

  private helper(): void {}
}
