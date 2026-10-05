/** What the admin API's endpoints answer, as its contract types them. */
import type { AdminApi } from "@via/server/admin-api";
import type { HttpApiEndpoint } from "effect/unstable/httpapi";

type Groups = (typeof AdminApi)["groups"];

type SuccessOf<Endpoint> = HttpApiEndpoint.Success<Endpoint>["Type"];

export type Account = SuccessOf<Groups["accounts"]["endpoints"]["list"]>[number];

export type OpencodeGoAccount = SuccessOf<Groups["opencodeGo"]["endpoints"]["list"]>[number];

/** Where Ollama is, when via knows one. */
export type Ollama = NonNullable<SuccessOf<Groups["ollama"]["endpoints"]["get"]>>;

/** What via found at an address it was asked to check for Ollama. */
export type OllamaCheck = SuccessOf<Groups["ollama"]["endpoints"]["check"]>;

/** OpenRouter's key, masked, and the models via offers of it. */
export type Openrouter = NonNullable<SuccessOf<Groups["openrouter"]["endpoints"]["get"]>>;

/** A model OpenRouter lists, to enable or not. */
export type OpenrouterModel = SuccessOf<Groups["openrouter"]["endpoints"]["catalog"]>[number];

export type Key = SuccessOf<Groups["keys"]["endpoints"]["list"]>[number];

export type StartedLogin = SuccessOf<Groups["accounts"]["endpoints"]["login"]>;

export type LoginStatus = SuccessOf<Groups["accounts"]["endpoints"]["loginStatus"]>;

export type Usage = SuccessOf<Groups["usage"]["endpoints"]["get"]>;

export type Pool = SuccessOf<Groups["pool"]["endpoints"]["get"]>;

export type PoolAccount = Pool["accounts"][number];

export type PoolProvider = Pool["providers"][number];

export type Model = SuccessOf<Groups["models"]["endpoints"]["list"]>[number];

export type HistorySeries = SuccessOf<Groups["history"]["endpoints"]["series"]>;

export type HistoryBreakdown = SuccessOf<Groups["history"]["endpoints"]["breakdown"]>;

export type HistoryGroup = HistoryBreakdown["groups"][number];

export type RequestPage = SuccessOf<Groups["history"]["endpoints"]["requests"]>;

export type UsageRequest = RequestPage["requests"][number];

/** A model's fallback rule, and how it stands now. */
export type Fallback = SuccessOf<Groups["fallbacks"]["endpoints"]["list"]>[number];

/** Whether a model could serve a request now, as a fallback rule's status says. */
export type Availability = Fallback["status"]["source"];
