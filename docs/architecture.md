# Architecture

```text
Pi
├── JEV harness (native extension)
│   ├── route: selects useful tools and context prefetch
│   ├── model policy: chooses cost/sufficiency and thinking level
│   ├── subscription policy: answer-only compatibility routes
│   ├── shadow: logs each route against the no-JEV baseline
│   ├── loop/guard: free reminders at 3/5/8 repeats, Jev check from 5, risky operations
│   └── trim: removes low-relevance tool output before generation, full text spilled to disk
├── RL engine (native extension)
│   └── lessons: verified task lessons; model facts and model pins are refused
├── Subscription providers (native extension)
│   ├── account pools: switch on quota/login failure, then Pi's retry or a resend
│   ├── cursor-agent -> readiness/model metadata cache
│   └── agy stream-json -> readiness/model metadata cache
└── DCP (third-party extension)
    ├── deduplication
    ├── stale error-input purge
    └── model-callable compress tool
```

JEV reads the provider readiness cache; it does not spawn subscription CLIs on every turn. Subscription probes run in the provider extension's background refresh path. DCP's `compress` tool is explicitly kept in JEV's always-keep tool set so the two optimizers do not disable each other.
