// @kolmogorov/kolm-sdk - TypeScript declarations.
// Client for kolm account, registry, receipt, and recipe APIs.

export type Visibility = "private" | "public";

export interface RecipeClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface Example<I = unknown, O = unknown> {
  input: I;
  expected: O;
}

export interface OutputSpec {
  type?: "boolean" | "number" | "string" | "enum" | "array" | "object";
  enum?: readonly string[];
  schema?: unknown;
}

export interface SynthesizeRequest<I = unknown, O = unknown> {
  name?: string;
  description?: string;
  positives: ReadonlyArray<Example<I, O>>;
  negatives?: ReadonlyArray<Example<I, O>>;
  output_spec?: OutputSpec;
  priors?: Record<string, unknown>;
  tags?: readonly string[];
  visibility?: Visibility;
  publish?: boolean;
}

export interface SynthesizeResponse {
  accepted: boolean;
  reason?: string;
  concept_id: string | null;
  version_id: string | null;
  recipe_id?: string | null;
  strategy: string;
  attempts_n: number;
  duration_ms: number;
  best_source?: string;
  best_result?: {
    quality_score: number;
    pass_rate_positive: number;
    reject_rate_negative: number;
    latency_p50_us: number;
  };
}

export interface RunResponse<O = unknown> {
  output: O;
  latency_us: number;
  cache: "L1" | "L2" | null;
  version_id?: string;
}

export interface Recipe {
  id: string;
  name: string;
  description?: string;
  tags: readonly string[];
  visibility: Visibility;
  versions: number;
  head_version: string;
  updated_at: string;
}

export interface RecipeStats {
  concept_id: string;
  name: string;
  invocations: number;
  cache_hit_rate: number;
  error_rate: number;
  latency_us: { p50: number; p95: number; p99: number; avg: number };
  last_invoked_at?: string;
  versions: number;
}

export interface ComposeOptions {
  query: string;
  input: unknown;
  k?: number;
  strategy?: "attention" | "voting" | "top1" | "sequential";
  threshold?: number;
}

export interface LabelCorpusOptions {
  rows?: ReadonlyArray<{ input: unknown } | string>;
  hf_dataset?: string;
  url?: string;
  max_rows?: number;
  output_format?: "json" | "csv";
}

export interface LabelCorpusResponse {
  job_id: string;
  status: "completed" | "queued" | "running" | "failed";
  recipe_id: string;
  rows_labeled?: number;
  errors?: number;
  duration_ms?: number;
  sample?: ReadonlyArray<{ idx: number; input: unknown; label: unknown }>;
  message?: string;
  est_rows?: number;
}

export interface SpecialistTrainRequest {
  name: string;
  recipe_id: string;
  base_model?: string;
  rank?: number;
  corpus?: { type: "inline" | "huggingface" | "url"; rows?: unknown[]; name?: string; url?: string };
}

export interface Specialist {
  id: string;
  name: string;
  recipe_id: string;
  base_model: string;
  rank: number;
  status: "queued" | "labeling" | "training" | "completed" | "failed";
  est_minutes?: number;
  weights_url?: string;
  pipeline?: string;
  created_at: string;
}

export class RecipeError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown);
}

export class RecipeClient {
  readonly baseUrl: string;
  readonly apiKey?: string;
  constructor(opts?: RecipeClientOptions);

  synthesize<I = unknown, O = unknown>(req: SynthesizeRequest<I, O>): Promise<SynthesizeResponse>;
  synthesizeBatch(items: SynthesizeRequest[]): Promise<{ accepted: number; total: number; results: SynthesizeResponse[] }>;
  verify(source: string, examples: Example[]): Promise<{ pass_rate: number; trace: unknown[] }>;
  run<O = unknown>(opts: { recipe_id?: string; concept_id?: string; version_id?: string; input: unknown }): Promise<RunResponse<O>>;

  list(opts?: { tag?: string; q?: string; limit?: number }): Promise<{ recipes: Recipe[] }>;
  get(recipe_id: string): Promise<Recipe & { versions: unknown[] }>;
  stats(recipe_id: string): Promise<RecipeStats>;
  search(query: string, k?: number): Promise<{ matches: Array<Recipe & { score: number }> }>;
  compose(opts: ComposeOptions): Promise<{ dispatched: unknown[]; result: unknown; strategy: string; latency_us: number }>;

  labelCorpus(recipe_id: string, opts: LabelCorpusOptions): Promise<LabelCorpusResponse>;
  job(id: string): Promise<unknown>;
  waitlistSpecialist(email: string, task: string): Promise<{ position: number; message: string; email: string }>;
  trainSpecialist(req: SpecialistTrainRequest): Promise<{ specialist_id: string; status: string; est_minutes: number; pipeline: string }>;
  listSpecialists(): Promise<{ specialists: Specialist[] }>;
  getSpecialist(id: string): Promise<Specialist>;
  runSpecialist(id: string, input: unknown): Promise<{ output: unknown; latency_ms: number; model: string; source: string }>;

  featured(): Promise<{ featured: Recipe[] }>;
  publicConcepts(): Promise<{ concepts: Recipe[] }>;
  publicRun(opts: { concept_id?: string; version_id?: string; input: unknown }): Promise<RunResponse>;
  account(): Promise<{ id: string; name: string; plan: string; quota: number; used: number; remaining: number }>;
  rotateKey(): Promise<{ api_key: string }>;
  signup(email: string, name?: string): Promise<{ tenant: { id: string; name: string; plan: string; quota: number }; api_key: string }>;
  health(): Promise<{ status: string; version: string; uptime_s: number }>;
}

export class KolmClient extends RecipeClient {}

export const recipe: {
  isSpam(text: string): Promise<boolean>;
  classifyIntent(text: string): Promise<string>;
  detectLanguage(text: string): Promise<string>;
  sentiment(text: string): Promise<"positive" | "negative" | "neutral">;
  isQuestion(text: string): Promise<boolean>;
  classifyToxicity(text: string): Promise<string>;
  extractEmails(text: string): Promise<string[]>;
  classifyIssue(text: string): Promise<"bug" | "feature" | "billing" | "account">;
};

export default KolmClient;
