# @kolm/langchain

First-party LangChain adapter for kolm.ai compiled artifacts. Drop a `.kolm` into any LangChain agent in 3 lines.

## Install

```bash
npm install @kolm/langchain langchain @langchain/core
```

## Usage (3 lines)

```js
import { KolmLLM } from '@kolm/langchain';
const llm = new KolmLLM({ artifactPath: './phi-redactor.kolm' });
const out = await llm.invoke('Redact: My SSN is 123-45-6789.');
```

The `.kolm` artifact runs as a local subprocess via the `kolm` CLI. Zero outbound calls. The receipt chain (cid, k_score, audit_id) is preserved on `llm.lastReceipt` after every call.

## HTTP mode

```js
const llm = new KolmLLM({
  baseUrl: 'https://kolm.example.internal',
  artifactPath: 'phi-redactor',
  apiKey: process.env.KOLM_API_KEY,
});
```

## Receipt chain

```js
const { text, receipt } = await llm.invokeWithReceipt(prompt);
console.log(receipt.cid, receipt.k_score);
```

## Peer dependencies

`langchain` and `@langchain/core` are peer deps. The adapter ships with zero runtime dependencies.
