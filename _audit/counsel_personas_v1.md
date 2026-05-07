# Counsel of 100 — kolm.ai user simulation v1

10 archetypes × 10 personas each. Each persona rates kolm.ai (homepage + signup + console + first-compile attempt) on four dimensions /10, then gives 2-3 sentences of critical feedback. Aggregate average must clear 9.2/10.

## Rating dimensions
- **A — Aesthetics** (Apple-grade restraint, typography, distinctive design)
- **F — Functionality clarity** (do I understand what kolm does, can I figure out next step)
- **T — Trust / credibility** (do I believe the claims, would I put real data in this)
- **U — Use-intent** (would I actually run `kolm compile` this week)

## Archetypes

### A. Solo developers / indie hackers (10)
1. **Maya, 26, Brooklyn, ex-Stripe eng, building an AI side-project** — JS native, learned Python for ML, ships on Vercel. Reads HN every morning. Skeptical of "compiler" framing if it's just a wrapper.
2. **Jules, 31, Amsterdam, freelance React contractor + 4k GH followers** — open-source maximalist, suspicious of cloud-only products, will close the tab if there's no curl one-liner.
3. **Adam, 23, Lagos, building an SMS-first AI product for under-banked merchants** — bandwidth-constrained, evaluates everything by "will this work offline".
4. **Priya, 34, Bangalore, ex-Google L5 turned indie** — wants `pip install` not `npm install`, will judge entire pricing in five seconds.
5. **Felix, 29, Berlin, OSS contributor to llama.cpp** — knows quantization deeply, will tear apart any handwave around "INT4 LoRA" unless math checks out.
6. **Sam, 41, Toronto, TypeScript devtools founder** — has launched two SaaS, spots half-baked products in 30s, asks "what does month-2 retention look like".
7. **Lin, 27, Taipei, hardware-adjacent, builds AI gadgets on Raspberry Pi** — cares about <1GB artifacts and ARM support.
8. **Diego, 35, São Paulo, ex-Apple engineer, now solo on macOS-first AI tooling** — design-snob, will dismiss anything that uses Inter when SF Pro is available.
9. **Hana, 24, Seoul, Korean dev YouTube channel (90k subs)** — wants demo-able in 60 seconds for a video shoot.
10. **Rashid, 38, Dubai, builds Arabic LLM products** — checks if multilingual / non-Latin scripts work in the corpus pipeline.

### B. Startup ML engineers / applied researchers (10)
11. **Owen, 30, SF, ML lead at a Series B vertical-SaaS** — rolled their own LoRA fine-tuning pipeline; needs to know what `kolm compile` does that Together's tune doesn't.
12. **Ana, 33, NYC, ML eng at a fintech (regulated, bank infra)** — needs SOC 2, needs deletion semantics, needs offline mode.
13. **Dmitri, 36, London, ex-DeepMind, joined hot startup as IC** — judges the tech moat first, copy second.
14. **Yui, 28, Tokyo, applied researcher at a robotics startup** — needs vision-grounded inference; cares about CLIP embedding fidelity.
15. **Alex, 32, Boston, biotech NLP scientist** — needs retention + lineage + zero PII to leave premises; will ask about HIPAA.
16. **Nadia, 30, Tel Aviv, applied LLM researcher at a security startup** — wants control over what data the frontier provider sees during distill.
17. **Wei, 27, Shenzhen, MLOps eng at a video startup** — needs pipeline traceability; obsessed with reproducibility.
18. **Reza, 39, Stockholm, ex-research engineer at HuggingFace** — will compare kolm's design directly to AutoTrain.
19. **Tara, 34, Austin, ML consultant** — sells outcomes to enterprises, needs a product to recommend.
20. **Karim, 29, Cairo, applied scientist at an Arabic search startup** — needs the embedder to handle Arabic morphology; default English-only is a dealbreaker.

### C. AI-app founders shipping product (10)
21. **Rachel, 32, Miami, founder of a personal-finance AI co (Series Seed, $2M)** — needs the artifact runnable in users' browsers without sending data home; will ask about pricing on per-user basis.
22. **Tom, 36, Singapore, founder of a B2B legal AI co** — needs deterministic outputs (not "verified-with-some-jitter"); contracts explode if they hallucinate.
23. **Lila, 28, LA, founder of a creative-tools AI co** — needs latency under 200ms; cares about voice fidelity in generated outputs.
24. **Bashir, 35, Riyadh, founder of an Arabic education AI** — needs Arabic + English; cares deeply about offline mode for low-connectivity classrooms.
25. **Eva, 30, Berlin, founder of a B2B compliance AI co (GDPR-native)** — needs EU data residency, signed audit trail.
26. **Nikhil, 29, Mumbai, founder of a healthcare AI for clinics** — needs <2 GB artifact, must run on Android tablets.
27. **Caleb, 38, Denver, founder of an outdoor-gear AI assistant** — needs offline mode (mountain backcountry); cares about battery cost on iPhone.
28. **Ji-won, 31, Seoul, founder of an AI tutor for K-12** — needs Korean education content; pricing matters to parents not VCs.
29. **Marco, 41, Milan, founder of a fashion AI** — visual-first; cares about CLIP / vision tower quality more than text.
30. **Shaila, 33, Toronto, founder of a healthcare AI co (HIPAA scope)** — needs lineage/audit; will deeply read /docs and /receipts.

### D. Enterprise architects / regulated buyers (10)
31. **Henry, 49, NYC, Chief Architect at a top-3 US bank** — needs SOC 2 Type II, on-prem, ISO 27001, signed BAA. Will reject without a SLA.
32. **Marisol, 45, Madrid, IT director at a national insurance co** — GDPR + national-residency. Procurement will take 9 months.
33. **Brian, 51, Chicago, VP Eng at a healthcare AI co (HIPAA)** — wants kolm artifact deployable in private VPC; needs HSM key custody.
34. **Aiko, 47, Tokyo, IT lead at a bank** — needs Japanese-language docs + on-prem.
35. **Ethan, 53, DC, federal-civilian agency CIO** — needs FedRAMP + air-gapped install.
36. **Fatima, 40, Dubai, regional director at an oil + gas major** — wants on-rig deployment offline; cares about ARM/Linux edge.
37. **Lukas, 50, Frankfurt, head of architecture at a logistics firm** — wants German + English; cares about stable CLI semver.
38. **Olivia, 44, Sydney, GM of digital at a national supermarket chain** — wants in-store edge AI; cares about deployment bundle <500MB.
39. **Tariq, 46, Kuala Lumpur, CIO at a regional telco** — wants local language support; cares about per-tenant isolation.
40. **Sandra, 48, Boston, VP at a defense subcontractor** — needs ITAR-clean supply chain; will ask about base-model provenance.

### E. Mobile / iOS developers (10)
41. **Kai, 28, San Diego, indie iOS dev with a hit photo app** — will judge by the demo on iPhone 12; cares about RAM ceiling.
42. **Renee, 31, Paris, senior iOS at a fintech** — needs Swift package, Apple Foundation Models comparison.
43. **Kenji, 34, Osaka, mobile architect** — will check if kolm works with on-device Apple/Google models or insists on its own.
44. **Mia, 26, Mexico City, indie Android dev** — Pixel-first; cares about Android Tablet support.
45. **Henrik, 29, Oslo, cross-platform dev** — wants React Native / Expo wrapper.
46. **Sofie, 33, Copenhagen, mobile at a music app** — cares about background processing limits; will ask about iOS Background Modes.
47. **Anand, 28, Hyderabad, Flutter dev at an edu app** — wants a Dart binding eventually.
48. **Lara, 30, Dublin, Apple ecosystem evangelist** — judges by typography + haptic feel; will close anything that doesn't honor Dynamic Type.
49. **Pedro, 35, Lisbon, mobile dev for marine industry** — needs hard offline; cares about <1GB models on iPad mini.
50. **Hyo-jin, 27, Busan, Korean mobile gaming dev** — wants ultra-low latency for in-game NPCs.

### F. Data scientists / analysts (10)
51. **Carmen, 36, Mexico City, data scientist at a retail chain** — wants Jupyter integration; will ask "can I run this in a notebook".
52. **Bert, 39, Amsterdam, freelance DS** — pythonista, hates installing global npm packages.
53. **Tomi, 31, Lagos, data eng for a fintech** — wants `pip install kolm` and a one-liner for Postgres ingestion.
54. **Greta, 28, Munich, junior DS** — will only use products with a free tier and a notebook quickstart.
55. **Wei-Chen, 34, Taipei, senior DS** — Chinese-language corpora; will check tokenizer behavior.
56. **Marina, 41, Buenos Aires, lead DS at gov agency** — Spanish-first docs preferred; will judge translatability.
57. **Femi, 29, Accra, DS at NGO** — needs free-tier generosity; will run on a laptop with 8GB RAM.
58. **Rohit, 33, Bengaluru, DS at e-commerce** — wants A/B testing primitives in `kolm.run`.
59. **Elke, 38, Vienna, DS turned product** — will rate product clarity higher than any other axis.
60. **Joon, 30, Seoul, biostat** — wants reproducibility with seeded randomness.

### G. CTO / VP Engineering (10)
61. **Patricia, 44, San Francisco, CTO of a Series C SaaS** — buys for her team; needs ROI within 60 days.
62. **Robin, 47, Seattle, VP Eng at e-commerce platform** — wants integration story with existing stack (Datadog, Stripe).
63. **Zara, 41, London, CTO of an AI-native startup** — already runs Together; needs a reason to switch.
64. **Mohammed, 49, Riyadh, CTO of a regional fintech** — will check Arabic + Saudi data residency.
65. **Hiro, 50, Tokyo, CTO of a video-tech co** — sensitive to GPU costs; will ask about per-1k-tokens.
66. **Beth, 45, Austin, VP Eng at a healthcare-tech co** — needs HIPAA + audit log.
67. **Niall, 43, Dublin, VPE at a global SaaS** — wants single-pane visibility across multiple specialists.
68. **Yulia, 39, Tel Aviv, CTO at a security-tech co** — wants threat-model docs.
69. **Cameron, 46, Vancouver, VPE at a mid-market app** — will ask about migration story from Cohere/OpenAI.
70. **Elena, 42, Madrid, CTO at edtech** — wants Spanish/Portuguese support; cares about PII in education.

### H. Designers / product people (10)
71. **Sasha, 32, NYC, design director at a Fortune 500** — judges typography hierarchy and image-in-text execution; will note any em-dash slop instantly.
72. **Pierre, 35, Paris, founder of a design tool** — will compare landing to Linear / Vercel / Stripe.
73. **Jia, 28, Shanghai, designer at a content app** — wants a non-English example in the demo.
74. **Hugo, 41, Lisbon, design lead at a hardware co** — will judge whether the artifact card actually feels like a passport.
75. **Mira, 30, Helsinki, product designer** — wants the empty state of the dashboard to teach what kolm is.
76. **Sebastian, 38, Mexico City, principal designer** — will rate spacing and rhythm.
77. **Bella, 26, LA, ex-FAANG designer** — color-token snob; will note any drift in palette consistency.
78. **Nuno, 34, São Paulo, Brand designer** — will judge logo / wordmark / favicon coherence.
79. **Laila, 31, Cairo, UX researcher** — will ask "what happens when the user has 0 corpus rows".
80. **Tom, 39, Manchester, designer turned PM** — judges by what he'd present to a CPO.

### I. Non-technical buyers + economic decision-makers (10)
81. **Quinn, 39, NYC, founder of a Series B agency** — non-technical; needs explanation for board.
82. **Vivian, 47, SF, partner at a seed VC** — invests in AI infra; will ask about defensibility.
83. **Hank, 51, Chicago, lawyer turned legaltech founder** — needs contract review specialist; non-technical.
84. **Penny, 36, London, COO of a logistics co** — operations-first; wants compile to "save 5h/week".
85. **Dario, 53, Milan, partner at a PE firm** — needs the receipt + audit story for portfolio diligence.
86. **Bea, 44, Paris, head of innovation at L'Oréal** — wants brand-safe outputs.
87. **Glenn, 49, Toronto, GM of a media co** — needs licensing of training data clarity.
88. **Sina, 32, Berlin, ex-McKinsey founder** — wants ROI math up-front.
89. **Carolina, 37, Bogotá, head of partnerships at a bank** — needs Spanish-language docs.
90. **Ravi, 41, Dubai, head of digital at govt** — needs Arabic + sovereignty language.

### J. Skeptics / adversarial reviewers (10)
91. **Erik, 33, Stockholm, AI skeptic + LLM Twitter critic (45k followers)** — will tweet about any handwave.
92. **Layla, 29, Tehran, security researcher** — will probe the upload path for SSRF/XSS.
93. **Gus, 51, Austin, technical writer who reviews dev tools for IEEE** — will rate docs harshly.
94. **Catalina, 36, Lima, regulatory consultant** — checks compliance phrasing.
95. **Niko, 27, Athens, GH issues troll on too many repos** — will file three issues in 10 minutes if anything 404s.
96. **Mei, 38, Hong Kong, ML safety researcher** — wants alignment + harmful-output story.
97. **Boris, 45, Moscow (relocated to Tbilisi), ex-research scientist** — will ask if frontier teacher does any data exfil.
98. **Yael, 31, Tel Aviv, prompt-injection researcher** — will probe `/v1/compile` for injection vectors.
99. **Pete, 56, London, classic Linux greybeard turned AI critic** — will judge whether the CLI honors XDG / has a man page.
100. **Asha, 33, Boston, journalist (The Information beat)** — will write a piece on whether the moat is real.

## Method

For each persona, I (or a sub-agent) walks the live experience:
1. Land on https://kolm.ai
2. Read homepage above-the-fold
3. Click signup
4. Read pricing
5. Imagine running `kolm compile` against their corpus
6. Score A/F/T/U
7. Write 2-3 sentence critical feedback

After 100 ratings, aggregate by archetype + by dimension. Theme-cluster the feedback. Apply the top-N themes that block 9.2/10. Re-pitch.
