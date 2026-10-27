---
title: License
description: "What the FSL-1.1-MIT license lets you do with Piwi, what it rules out, which parts are MIT, and when each release becomes MIT."
lang: en-US
---

# License

Piwi is fair source. The dashboard, the server, the desktop app and the browser extension are published under the
[Functional Source License, Version 1.1, MIT Future License](https://github.com/PiwiTests/piwi/blob/main/LICENSE)
(FSL-1.1-MIT). The parts that run inside your own projects are MIT.

## What you can do

Use Piwi for free, for any purpose other than competing with it. That covers:

- running it for your team or your whole company, on your own servers, in the desktop app or from the Docker image;
- changing the code, and running your changed copy;
- using it for teaching and non-commercial research;
- setting it up or running it for a client who uses it for their own work, as a consultant or contractor.

## What it rules out

Making Piwi available to others in a commercial product or service that substitutes for it, or that offers the same or
substantially similar functionality. Selling hosted Piwi is a competing use, and so is reselling it, or a product built
from its code, under another name.

If you redistribute Piwi or a modified copy, include the license, or a link to it, and keep the copyright notices. The
license gives no right to use the Piwi name or logo beyond saying where the software comes from.

## Each release becomes MIT after two years

Every release carries an irrevocable grant: two years after the date it is published, that release is also available
under the MIT License, with no restriction on competing use. Newer releases stay under FSL-1.1-MIT until their own two
years are up.

## Which parts are MIT

| Part | License |
|---|---|
| Dashboard, server (`@piwitests/server` and the Docker image), desktop app, browser extension | FSL-1.1-MIT |
| Playwright reporter (`@piwitests/reporter`) | MIT |
| Backend-log integrations (Nitro, ASP.NET Core, Serilog) | MIT |
| Examples | MIT |

The reporter and the integrations run inside your test suite and your application, so they keep the most permissive
license: nothing you ship depends on FSL-1.1-MIT code.

Releases up to v0.39.x were published under the MIT License, and stay under it.

## Questions

Not sure whether what you have in mind is a competing use? Ask in
[GitHub Discussions](https://github.com/PiwiTests/piwi/discussions) before you build it.

## Related
- [Privacy & data flow](./privacy) — what leaves your server, and what never does
- [Why Piwi?](./comparison) — how Piwi compares with the tools you may already use
