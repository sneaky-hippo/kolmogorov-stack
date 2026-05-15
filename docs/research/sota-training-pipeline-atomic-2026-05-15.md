# SOTA training pipeline, atomized

*2026-05-15. Research memo. What a small team running kolm.ai actually does at each step from `task -> .kolm` if they want defensible SOTA in 2026, not regex theatre.*

Reference points: Qwen 2.5 (Apr 2025), Llama 3.3 70B + Llama 4 Scout/Maverick (Apr 2026), Phi-4 14B (Mar 2025), Mistral Small 3 (Jan 2026), DeepSeek-R1-Distill (Jan 2025), Unsloth, axolotl, LLaMA-Factory, TRL, vLLM, SGLang, llama.cpp, MLX, Sigstore, in-toto. Numbers and license claims good as of this doc; verify before you ship.

---

## 1. Task scoping

**What it is.** Deciding what a single `.kolm` will and will not do. The unit of compilation.

**SOTA 2026.** Narrow enough that one 7B-or-smaller model at int4 hits the gate; wide enough that a buyer recognizes it as a job. Heuristic from OpenPipe/Predibase telemetry: tasks with <50 input/output schemas, <2k token I/O budget, and a verifiable check (regex, JSON-schema, classifier match, exact-set membership) compile cleanly. Anything that requires multi-hop reasoning or open-ended generation either decomposes into N tasks or stays on a frontier model.

**Recipe.** Write the task as one sentence ending in a verifier. "Redact PHI from clinical notes such that 18 HIPAA identifiers are absent under regex+NER check." "Classify support tickets into {billing, bug, auth, feature_request, how_to}." If you can't write the verifier, the task is not scoped. Reject the compile.

**Can't skip.** A deterministic verifier and a holdout that wasn't in training. **Can skip.** Hand-tuning the size of the model; let the eval gate pick. Start at 1.5B-3B int4 and only escalate when the gate refuses to close.

## 2. Dataset curation

**What it is.** Getting (input, output) pairs that represent the task.

**SOTA 2026.** Four-stack pipeline: (1) **distillation** from a frontier model (Claude Sonnet 4.5, GPT-5, Gemini 2.5 Pro) generates the bulk; (2) **human spot-label** ~5-10% as ground truth; (3) **synthetic augmentation** via Evol-Instruct / Magpie / Self-Instruct for coverage; (4) **weak supervision** (Snorkel-style labelling functions) for negative classes. Frontier distillation is now the default; most open Qwen/Llama post-trains since 2025 are explicitly distilled from GPT-4-class teachers. Beware OpenAI's ToS clause on training a competing model; Anthropic's commercial terms are looser, Google's allow research-only.

**Recipe.** 500-2000 pairs is the sweet spot for a LoRA fine-tune. Generate 3-5k with Claude/GPT, dedupe with MinHash or SemHash, run a quality filter (perplexity under teacher + length sanity + schema validation), reserve 10% for holdout never seen during any training pass. For classifier-style tasks, look at NuMind's NuNER pipeline; for generation, Magpie + WizardLM-2 self-improvement loop.

**Can't skip.** Holdout isolation (use a hash-prefix split, not random; random leaks via near-duplicates). **Can skip.** RLHF-grade preference pairs at this stage; do them in step 7 if needed.

## 3. Anonymization / PII for regulated verticals

**What it is.** Stripping or surrogating identifiers before the data leaves the customer's trust boundary, and before any frontier teacher sees it during distillation.

**SOTA 2026.** Hybrid: (1) **NER models** specialized on PII (Presidio from Microsoft, plus the GLiNER-PII family or NuNER-Zero) are the open SOTA, hitting >0.95 F1 on i2b2/n2c2-style benchmarks. (2) **Format-preserving tokenisation** (Vault by HashiCorp, Skyflow, or DIY with AES-FF1) for surrogate values that round-trip. (3) **Differential privacy** at training time via DP-SGD with epsilon ~3-8 on the LoRA pass (Opacus, dp-transformers); 2026's open work shows <2pt utility loss at eps=8 on 7B models for redaction tasks. (4) **k-anonymity audits** on the resulting dataset before it leaves the boundary, via Mondrian or ARX for tabular slices.

**Recipe.** Run Presidio + GLiNER-PII as parallel detectors, take the union, surrogate with FF1 keyed by a per-tenant secret so the same real value maps to the same fake. Keep the mapping table inside the customer VPC; ship only the surrogated set to the distillation step. If the data is HIPAA-regulated and you cannot legally egress even surrogates, run distillation on a self-hosted Llama 3.3 70B or Qwen 2.5 72B (BAA-friendly via Azure OpenAI is the exception but expensive).

**Can't skip.** A second-pass automated audit on the redacted corpus (Presidio + GLiNER again, on the output). PII leak rate >0% means you re-run the pipeline. **Can skip.** Differential privacy if the data is non-sensitive demonstration data; DP costs utility and only matters when membership-inference attacks are in the threat model.

## 4. Base model selection

**What it is.** Choosing what gets fine-tuned.

**SOTA 2026 (license + practical fit).** **Qwen 2.5 7B / 14B** (Apache 2.0, strongest open small model, multilingual, fits int4 on 12GB consumer GPU); **Llama 3.3 70B** when you can afford 48GB (Meta community license, free <700M MAU); **Llama 4 Scout 17B-A** for sparse MoE on a single H100 (Apr 2026, community license); **Phi-4 14B** for reasoning-heavy tasks (MIT license, distilled from GPT-4o, punchy at small size); **Mistral Small 3 24B** (Apache 2.0, fast, weaker on multilingual). Avoid Llama 2/3.1 if you can; strictly worse at the same parameter count. Avoid Gemma 2/3 for commercial unless you read the prohibited-use clauses carefully.

**Recipe.** Default to **Qwen 2.5 7B int4** for laptop-deployable tasks; jump to **Phi-4 14B int4** when reasoning matters; jump to **Llama 3.3 70B int4 on a 48GB card** for hard tasks. Pull weights from HuggingFace, verify the SHA256 against the published manifest, store the digest in your `compile-lock.json`.

**Can't skip.** License audit: community licenses (Meta) have user-count clauses, Gemma has use-case clauses, and "research only" base models will get your enterprise customer's legal team to block the deal. **Can skip.** Comparing 6 base models per task; pick one per task tier (small / medium / large) and stick with it until the eval gate forces a swap.

## 5. Tokenizer and chat template

**What it is.** The unknown unknown. Most "my fine-tune is broken" tickets in 2025-2026 trace back to a wrong chat template at inference.

**SOTA 2026.** Every modern open model ships a `tokenizer_config.json` with a Jinja `chat_template`. Llama 3+ uses `<|begin_of_text|><|start_header_id|>...`. Qwen 2.5 uses `<|im_start|>...<|im_end|>`. Phi-4 uses `<|im_start|>` (Qwen-style, different from Phi-3). MLX, llama.cpp, vLLM, and TGI all honor the embedded Jinja template if you let them, but if you pass raw strings you get silent degradation.

**Recipe.** During fine-tune (TRL `SFTTrainer` or axolotl), set `chat_template` explicitly from the base model, do NOT overwrite it, do NOT add new special tokens unless you also resize the embedding matrix and warm-start the new rows. At inference, always go through `tokenizer.apply_chat_template(..., add_generation_prompt=True)`; never hand-concatenate strings. Pin the tokenizer SHA in `compile-lock.json` alongside the weights.

**Can't skip.** Round-trip test: take 5 training examples, tokenize with the production path, decode, diff against the source. Mismatch == bug. **Can skip.** Custom special tokens; almost never worth the embedding-init cost on small fine-tunes.

## 6. Fine-tuning

**What it is.** Adapting the base model to the task.

**SOTA 2026.** **QLoRA** is the default: 4-bit NF4 base, LoRA adapters in bf16, paged optimizer. **DoRA** (Decomposed LoRA) is a measurable upgrade (~1-2pt on hard tasks) at ~10% compute overhead and is now stable in PEFT 0.14+. **rsLoRA** (rank-stabilised) helps at rank >=64. Full fine-tune (no adapters) is rarely worth it under 14B; the wins are <1pt and the storage/serving complexity is 100x. Unsloth's kernels give 2-3x speedup and 40-60% VRAM savings vs vanilla HuggingFace; axolotl is the production-quality YAML-driven wrapper; LLaMA-Factory is the GUI option.

**Recipe.** Start at **LoRA rank 16, alpha 32, dropout 0.05, target_modules = all-linear (q,k,v,o,gate,up,down), lr 2e-4 cosine, 3 epochs, batch_size effective 16, grad_accum 4, max_seq_len 2048, bf16, gradient checkpointing on.** Run on a single 24GB consumer GPU (RTX 4090, 5090) for 7B; rent a single H100 80GB ($1.50-$2/hr on Lambda/RunPod/Vast/CoreWeave) for anything bigger. Budget: a 7B QLoRA on 2k examples is ~30-90 minutes, ~$2-5 on rented GPU. Use Unsloth if you want it under 30 min.

**Can't skip.** Eval-during-training every N steps with the holdout, and early-stopping on it. **Can skip.** Hyperparameter search; the defaults above are within 1-2pt of optimum on >90% of small-task fine-tunes.

## 7. Preference optimization

**What it is.** Teaching the model what to prefer when SFT alone leaves it ambiguous. Used when the task has a "good vs almost-as-good" axis (style, refusal, helpfulness, tone).

**SOTA 2026.** **DPO** is still the workhorse but losing ground. **ORPO** combines SFT+preference into one pass and is now the default in most open recipes (Llama 3 Instruct, Qwen 2.5 Instruct were trained with variants of it). **SimPO** outperforms DPO on most benchmarks with simpler loss and no reference-model overhead; currently the strongest single-pass option. **KTO** (Kahneman-Tversky) works when you only have binary thumbs-up/down (no preference pairs); useful for production telemetry. **IPO** is mostly superseded.

**Recipe.** If you have <500 preference pairs: skip preference optimization, your SFT is fine. If you have 500-5000 pairs: **SimPO** with beta=2.0, gamma=1.4, lr 5e-7, 1-2 epochs. If you have thumbs-up/down telemetry from a deployed system: **KTO** with beta=0.1. If you're training a chat assistant from scratch: **ORPO** combining SFT and preference in one pass. TRL implements all four; defaults in TRL 0.13+ are sane.

**Can't skip.** A separate eval that measures the preference dimension (a judge model or a rubric), since gain on preference-loss does not always show up on task accuracy. **Can skip.** RLHF with PPO; almost never worth the instability vs DPO/SimPO/ORPO for tasks this small.

## 8. Distillation from frontier models

**What it is.** Using a stronger model to teach a smaller one.

**SOTA 2026.** Three regimes: (1) **response distillation**: frontier model generates outputs, student SFT-trains on them. The Llama 4 Scout, Phi-4, and DeepSeek-R1-Distill series all do this. The default for small teams. (2) **logits distillation** (KL on top-K logits): requires logprob access; OpenAI ships top-5, Anthropic does not, Together/Fireworks open-router proxies vary. ~2-3pt gain over response distillation, 5-10x cost. (3) **Speculative-decoding teacher pairs** (MEDUSA / EAGLE / Lookahead): train decoder heads against frontier model traces; gives serving speedup not task quality. Used when latency, not accuracy, is the gate.

**Recipe.** For a small specialised task: response distillation with Claude Sonnet 4.5 or GPT-5 as teacher; generate 2k-10k examples; pair with chain-of-thought traces if the task benefits (math, code, multi-step reasoning); store teacher version + prompt hash in `compile-lock.json` for reproducibility. If reasoning is critical, use DeepSeek-R1-style "long CoT distillation": let the teacher think for 1000+ tokens internally, then distill the final answer only OR distill the trace as well. Sky-T1 (Jan 2025) showed $450 of compute distilling R1 produces a 32B that beats o1-preview on math.

**Can't skip.** Logging teacher outputs verbatim alongside student training data; provenance matters if anyone audits. **Can skip.** Logits distillation under 14B; the cost rarely justifies the 2pt gain.

## 9. Quantization

**What it is.** Compressing weights from bf16 to 4-8 bits for cheaper serving.

**SOTA 2026.** **AWQ** and **GPTQ** (4-bit, weight-only) are the production GPU quantisers: AWQ slightly better quality, GPTQ slightly faster to produce. **GGUF Q4_K_M** is the CPU/Apple Silicon default via llama.cpp; surprisingly competitive on quality. **MLX-Q 4-bit** for Apple Silicon native (M-series Macs). **bitsandbytes NF4** is mostly for training-time, not serving. **EXL2** is the niche enthusiast format. **fp8** (E4M3) on H100/B200 hardware is now production-grade via vLLM and TGI and is the right answer when you have the silicon. Typical quality cost at int4: 1-3pt on instruction-following, <1pt on classification; at int8: indistinguishable; below int4 (int3, int2) is a research toy.

**Recipe.** Ship **AWQ int4** for GPU inference (vLLM, SGLang, TGI all consume it), **GGUF Q4_K_M** for laptop/desktop CPU and Apple Silicon (llama.cpp / Ollama / LM Studio). Keep the bf16 master in the artifact registry; quantize on demand. Measure quality on the holdout after quantising; if it drops more than 2pt, fall back to Q5_K_M or int8.

**Can't skip.** Post-quant eval against the same gate as pre-quant. **Can skip.** Mixed-precision experiments; defaults are well-tuned.

## 10. Evaluation

**What it is.** How you know it works.

**SOTA 2026.** Three layers: (1) **task-specific deterministic eval**: exact-match, F1, JSON-schema validity, regex coverage, on a versioned holdout. The gate. (2) **LLM-as-judge** for subjective dimensions: judge with a stronger model (GPT-5, Claude Opus 4.5, or for self-hosted, Llama 3.3 70B), use pairwise comparison not absolute scoring, swap positions to control for position bias. JudgeBench (2025) and PRM800K methodology are the references. (3) **Capability evals** as smoke tests: MMLU-Pro, HumanEval+, GSM8K-Hard, IFEval for instruction following; you don't need to win these, you need to not regress catastrophically. lm-evaluation-harness (EleutherAI) is the standard runner.

**Recipe.** Holdout split must be hash-prefix not random; minimum 200 examples; if <200, generate synthetic adversarial examples with a frontier model and human-check 20% of them. Run lm-evaluation-harness on 3-5 capability tasks as regression guard. For LLM-judge: 3 judges, majority vote, never the same model family as the student. Ship a single composite score; kolm's K-score is the right pattern (weighted accuracy + safety + latency + cost + verifier).

**Can't skip.** Holdout isolation hash check, judge-model independence, and explicit confidence intervals on small holdouts (bootstrap CI not asymptotic). **Can skip.** Wide benchmark coverage; pick 3 capability evals as regression guards and run them on every promote.

## 11. Adversarial and drift testing

**What it is.** Probing for failures that don't show up on the happy-path eval.

**SOTA 2026.** **Prompt injection probes**: PromptInject, Garak (NVIDIA, 2024), HouYi taxonomy. **Jailbreak suites**: JailbreakBench, HarmBench, StrongREJECT (the strongest fixed set as of early 2026). **Eval-set drift detection**: compare embedding distributions between training and production traffic via KL divergence or MMD; alert when divergence exceeds threshold. **Membership inference**: for regulated verticals where leaking training examples is a breach; use Tractable's MIA tooling or DIY with shadow models. **Backdoor/data poisoning probes**: TrojanLM, BadEdit for inserting and detecting backdoors during fine-tune.

**Recipe.** Run Garak with the default probes on every artifact pre-promote; fail any artifact that scores worse than the base model on the injection benchmark. For regulated verticals, run a 100-example MIA probe and require <55% attacker accuracy. For drift: bake a 50-example "canary set" into the artifact and re-evaluate on it weekly against production logs; if K-score on canary drops >5%, fire a drift alert.

**Can't skip.** Injection probes (Garak is one CLI call) and a drift canary. **Can skip.** Full red-team campaigns under 7B model size; the attack surface is small and the gain from a $50k red-team is mostly cosmetic.

## 12. Packaging

**What it is.** Wrapping the artifact for distribution with attestations the receiver can verify.

**SOTA 2026.** The OCI artifact + Sigstore + in-toto stack has won. **OCI 1.1 artifacts** (Cosign-compatible, ORAS for push/pull) are the container industry's standard for non-image artifacts. **Sigstore** (Fulcio for keyless signing via OIDC, Rekor for transparency log) is now used by PyPI, npm, Kubernetes, and most CNCF projects. **in-toto attestations** + **SLSA v1.0 provenance level 3** are the supply-chain standard. **Content-addressed identifiers**: SHA-256 hash is the floor; CIDs (IPFS-compatible multihash) are nicer but rarer in tooling.

**Recipe.** kolm's current model (receipt chain anchored to `RECIPE_RECEIPT_SECRET`) is fine for v0 but is a private chain. To match SOTA: emit an in-toto SLSA v1.0 provenance attestation per compile, sign it with Sigstore keyless (the buyer's CI gets an OIDC identity; no key management); push the attestation to Rekor; make the `.kolm` an OCI artifact pushable to any OCI registry (ghcr.io, ECR, GAR, Docker Hub). Buyer verifies with `cosign verify-attestation` + `slsa-verifier`. This is the work tracked as "Sigstore/Rekor anchoring" in SOTA-2026-05-11.md §3.5.

**Can't skip.** Content-addressed identifier, signed manifest with input/output schemas, version pin on every dependency. **Can skip.** Custom signing infra; use Sigstore keyless. Custom registry; OCI 1.1 on any cloud registry is fine.

## 13. Serving

**What it is.** Running the artifact in production.

**SOTA 2026.** **Local**: **llama.cpp** (GGUF, CPU+GPU+Metal+CUDA, the most-deployed local runtime), **MLX** (Apple Silicon native, fastest on Macs), **Ollama** (llama.cpp wrapper with model registry, dev ergonomics), **ONNX Runtime + DirectML** for Windows GPU non-CUDA, **CoreML** for iOS/iPadOS. **Cloud**: **vLLM** (paged attention, continuous batching, the de-facto standard for self-hosted; v0.7+ supports speculative decoding, prefix caching, structured output), **SGLang** (faster than vLLM on structured/JSON tasks, RadixAttention), **TGI** (HuggingFace, well-supported, slightly slower than vLLM), **TensorRT-LLM** (NVIDIA, fastest single-GPU, painful to build). For agent/multi-turn workloads, vLLM + prefix caching is the right answer; for high-throughput single-turn classification, SGLang.

**Recipe.** Default split: **GGUF Q4_K_M for laptop/edge + llama.cpp**, **AWQ int4 for cloud + vLLM**. Same logical artifact, two packagings. vLLM with `--enable-prefix-caching --enable-chunked-prefill --max-num-seqs 256` is the production starting point. For structured outputs, vLLM's `guided_json` / `guided_regex` (lm-format-enforcer or Outlines backend) is now stable. Monitor with vLLM's `/metrics` + Prometheus + Grafana; the load-bearing numbers are `vllm:gpu_cache_usage_perc`, `vllm:time_to_first_token_seconds`, `vllm:e2e_request_latency_seconds`.

**Can't skip.** A latency SLO and a load test (Locust + vegeta, or vLLM's own `benchmark_serving.py`). **Can skip.** Multi-framework serving; pick one local and one cloud, support both, ignore the rest until a customer pays for it.

## 14. Third-party verification

**What it is.** A stranger downloads your `.kolm`, proves to themselves it does what you claim, without trusting you.

**SOTA 2026.** Four ingredients: (1) **reproducible build**: same inputs (base model digest, dataset digest, recipe digest, base Docker image digest, CUDA driver version pin) produce byte-identical adapter weights. Rare in practice; usually adapter weights are bit-stable within ~10^-5 across CUDA driver patches. Most teams ship a "trusted reproducer" (Docker image + lockfile + script) and accept hash-equivalence on outputs rather than weights. (2) **signed attestation chain**: see §12. (3) **public eval reproducer**: `kolm bench --reproduce <artifact>` runs the artifact against a public holdout subset in a hermetic container, reports K-score, and signs the receipt. (4) **independent registry**: anchoring the artifact's hash to a transparency log (Rekor) or a public registry means tampering is detectable post-hoc.

**Recipe.** Ship the artifact + an OCI attestation + a `Dockerfile.reproducer` pinned by digest + a `compile-lock.json` listing every input hash + a small (20-50 example) public holdout the buyer can run. The buyer's CI does: `oras pull` → `cosign verify-attestation` → `slsa-verifier verify-artifact` → `docker run reproducer kolm bench --reproduce <artifact>` and compares K-score to claimed. If all four pass, the buyer has cryptographic + behavioral evidence. This is the "verified inference" story kolm's `/v1/verified-inference` and `/v1/wrap/verified` endpoints aim at; the gap today vs SOTA is Sigstore anchoring (P1 on §3.5) and a public holdout shipped with every artifact.

**Can't skip.** A public holdout per artifact; without it the cryptographic chain proves provenance but not behavior. **Can skip.** Byte-identical weight reproducibility under 14B; output-equivalence on the holdout is what the buyer cares about.

---

## The one paragraph

In 2026, a serious small-model training pipeline is: scope to a task with a deterministic verifier, distill 2k-5k pairs from a frontier teacher under a license that survives diligence, anonymize with Presidio + GLiNER + format-preserving surrogates, fine-tune a Qwen 2.5 7B or Phi-4 14B with QLoRA rank 16 alpha 32 via Unsloth in ~30 minutes on a rented H100 for ~$2, run SimPO if preference signal exists, quantize to AWQ int4 for cloud and GGUF Q4_K_M for edge, gate on a hash-isolated holdout + Garak injection probe + drift canary, sign with Sigstore keyless into an in-toto SLSA v1.0 attestation on an OCI 1.1 artifact, serve via vLLM in cloud and llama.cpp on device, ship the reproducer Dockerfile and a public holdout so a stranger can verify. kolm already does the artifact format, the K-score gate, and the receipt chain; the load-bearing gaps to match this pipeline are Sigstore anchoring, a real fine-tune backend behind `/v1/compile` (Unsloth + axolotl on rented H100 is the cheapest credible path), and a public-holdout artifact per compile.
