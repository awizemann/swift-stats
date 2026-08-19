---
id: t-51b9d0fb
title: P1 EventStore: bounded write amplification
status: done
added: 2026-08-19
priority: urgent
---

## Description

REOPENED by lead review: head marker stale after append → duplicate events on relaunch. Agent fixing + regression tests. (Original scope: bounded write amplification in EventStore.)

## Plan

1 read EventStore.swift + StorageTests.swift; 2 design head-marker (sidecar file or first-line header); 3 implement; 4 tests; 5 self-audit report

## Artifacts

Fixed: marker refreshed after every append with consumed prefix; recreated-file path resets consumed. 15 QueueFileTests. Lead-reviewed.

