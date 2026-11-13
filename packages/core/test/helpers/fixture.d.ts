export type FixtureName = "single-pkg" | "pnpm-turbo" | "nx";
export interface MaterializedFixture {
  dir: string;
  git: (args: string[]) => string;
  cleanup(): Promise<void>;
}
/** Copy a fixture to a temp dir, `git init -b main`, set a local user, commit everything as "fixture". */
export declare function materializeFixture(name: FixtureName): Promise<MaterializedFixture>;
