---
title: Configuration generator
description: "Build a ready-to-paste .env, Docker, Kubernetes or systemd configuration in your browser, from the same registry as the configuration reference."
lang: en-US
outline: false
---

# Configuration generator

<ConfigModeSwitch mode="generator" />

Build a ready-to-paste configuration for a self-hosted Piwi Dashboard — as a `.env` file, systemd unit or shell exports; a Docker Compose service, `docker run` command or Kubernetes ConfigMap + Secret; or a hosting-platform manifest for [Railway, Render, Fly.io, Koyeb or Coolify](/operate/deployment#one-click-deploy). Everything below is driven by the same typed registry as the [configuration reference](../configuration), so options, defaults and validation always match your server.

<EnvWizard />

## Related

- [Configuration reference](../configuration): every variable, its default and its limits
- [Deployment](/operate/deployment): where the generated configuration goes
