# ADR 0002: TypeScript everywhere, built-in local broker, Kafka/Redpanda adapter

- **Status:** Accepted (M1). Kafka path verified 2026-10-22 with Docker 29.9 / Redpanda: payments reach reconciled, 10 concurrent, no duplicate events after a full restart.
- **Date:** 2026-10-22

## Context

The demo must run on **one laptop with Wi-Fi off**, started by one command, on machines that may not
have Docker, Go or Java. A conference booth cannot depend on venue Wi-Fi or on a container runtime
starting cleanly. At the same time the architecture should be credible for a real platform, where a
Kafka-compatible log is the usual backbone.

## Decision

- **One language: TypeScript on Node.js** for services, tools and the UI, run directly with `tsx`
  (no build step for services). Shared types live in `packages/contracts`.
- **A small built-in broker** (`services/broker`): WebSocket transport, one topic, append-only file log
  in `DATA_DIR`, consumer groups with replay from the start. It is the default (`BUS=local`).
- **An `EventBus` interface** (`packages/event-bus`) with three adapters: local broker, in-memory
  (single-process tests) and **Kafka** (via `kafkajs`, for Redpanda or Kafka). Services pick one with
  `BUS`; their code does not change.
- `npm start` (tools/launcher) starts every service as a local process. Docker Compose
  (`deploy/`) is optional and offers a `redpanda` profile.

## Consequences

- + Runs offline after `npm install`, with no external infrastructure; fast start and reset.
- + Same contracts and code path in tests, on the laptop and in containers.
- + Swapping to Redpanda/Kafka is a configuration change, which is a good story to tell on stage.
- - We own a (small) broker: it is not durable or performant like Kafka and is only meant for the demo.
- - The Kafka adapter must be kept behaviourally equivalent. It has been run manually against Redpanda;
  it is not yet exercised in CI.
