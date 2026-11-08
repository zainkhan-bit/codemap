import { core } from "@mono/core";
import { add } from "@mono/core/math";
import React from "react";

export function App() {
  core();
  return <div>{add(1, 2)}</div>;
}
