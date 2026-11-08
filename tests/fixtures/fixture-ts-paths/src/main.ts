import { Service } from "@app/services/service";
import type { Config } from "@app/types";
import { util } from "./util.js";

const config: Config = { name: "x" };
const service = new Service(config);
service.run();
util();
