# Architecture

```text
Pi
├── JEV harness (native extension)
│   ├── route: selects useful tools and context prefetch
│   ├── model policy: chooses cost/sufficiency and thinking level
│   ├── subscription policy: answer-only compatibility routes
│   ├── loop/guard: catches repetition and risky operations
│   └── trim: removes low-relevance tool output before generation
├── Subscription providers (native extension)
│   ├── cursor-agent -> readiness/model metadata cache
│   └── agy stream-json -> readiness/model metadata cache
└── DCP (third-party extension)
    ├── deduplication
    ├── stale error-input purge
    └── model-callable compress tool
```


JEV reads the provider readiness cache; it does not spawn subscription CLIs on every turn. Subscription probes run in the provider extension's background refresh path. DCP's `compress` tool is explicitly kept in JEV's always-keep tool set so the two optimizers do not disable each other.