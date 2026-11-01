# Author's Note: From Rescuing a Decade of Memories to Building a Cross-Platform Private Knowledge Base

> The story behind BaseForge · [中文版本](./AUTHOR_STORY.md)

As a NAS hobbyist for seven or eight years, I've always believed that the endgame of tinkering with hardware is finding the perfect software to host your digital legacy.

This project wasn't born from some grand business plan. It came purely from a developer's instinct for "self-rescue" — and a touch of OCD — in the face of fragmented habits and constantly-changing hardware.

---

## I. Origin: A "Digital Archaeology" Triggered by a Phone Swap

Last year, I made a decision: I retired the Xiaomi phone that had accompanied me since high school and switched to a OnePlus.

Migrating devices sounds simple. But when I looked at the thousands of notes still sitting in Xiaomi Notes — spanning more than a decade, from awkward high-school years all the way into my professional career — I hit a wall. How do you elegantly export all of that? There was no official tool, and third-party solutions were lackluster at best.

As a software engineer, my professional reflex of *"if you can't tolerate it, rewrite it"* kicked in. I rolled up my sleeves, started analyzing the network traffic, grabbed the cookies, hit the internal APIs directly, and forcefully pulled out every last note from Xiaomi Notes.

But that was just step one. What followed was a nightmare of format compatibility: how to lay out text, how to elegantly back-fill image attachments asynchronously, how to align messy import timestamps with the original creation times… While complaining and patching at the same time, a text editor capable of "history-time backfill, view-and-edit" gradually took shape.

---

## II. Catalyst: An "Ecosystem Desert" Encountered While Tinkering with NAS

By Singles' Day (Nov 11), I took advantage of the sales to upgrade my home lab — replacing the Synology NAS that had served me for years with a domestic NAS brand.

The hardware leap was thrilling. But when I tried to migrate my note-taking workflow, I hit a serious letdown. On Synology, I was deeply reliant on **Note Station**. Its UI was a bit dated, but it supported web clipping, multi-device sync, and task lists — exactly what I needed daily. On the new system, the official note-taking ecosystem was practically a desert.

I started looking for alternatives in the open-source community:

- **SiYuan**: Powerful, no doubt, but felt cumbersome to deploy on a NAS, with a steep learning curve and too many features outside what I wanted — at odds with my preference for something intuitive and lightweight.
- **Memos**: Excellent for fragmented capture, but too thin for long-form knowledge management and serious editing.

I even compromised at one point and ran a hacked Synology inside a VM on the new NAS — purely so I could tunnel back into Note Station. But that clearly wasn't a long-term plan.

*"Forget it. I already have the editor prototype I wrote when migrating Xiaomi Notes — why not just build my own self-hosted note system, fully aligned with Synology Note Station, but with a more modern stack?"*

---

## III. Evolution: Coding My Own Quirks Into the Product

With that idea, the prototype of BaseForge was officially born.

I stitched and refactored every habit I had picked up over the years into this single system:

1. **A leftover obsession with Youdao Notes**: Since I'd also used Youdao Notes for a long time in high school, I built a dedicated Youdao backup importer to bring those memories home as well.
2. **Inline mind maps**: I rely heavily on mind maps in daily work, so I integrated a lightweight mind-map component directly into the editor.
3. **"Moments" feed**: I'm in the habit of muttering to myself in writing — a habit dating back to my school days. So instead of treating this as pure document management, I built a Moments-style stream (think WeChat Moments / Memos) for those incoherent sparks of thought.

Most importantly, as a NAS hobbyist with a strong urge to share, I knew exactly what people like us actually need: **absolute privacy, modern visual interactions, and seamless cross-device collaboration.**

So I built a solid backend on `React 18` + `Hono` + `SQLite`, and used `Electron` and `Capacitor` to ship Web, desktop (Win/macOS/Linux), and mobile (Android) builds out of the same codebase.

---

## IV. Transformation: From "Pleasing Myself" to "Serving Everyone"

At first, I thought "as long as it works, that's enough." But the moment I open-sourced the project, the wave of community feedback hit me like a freight train.

As a lone-wolf developer, I used to think very simplistically. Many features were shaped purely around my own habits, with zero consideration for HCI from a user's perspective. When users with all kinds of NAS setups, work habits, and edge cases started reaching out, I realized: real open source means shifting from "serving yourself" to "serving the community."

These past two months have been the most intense iteration phase. Pushed and challenged by the community, we've shipped a long list of hardcore improvements:

- **Dual rich-text + Markdown engines**: Brought in Tiptap 3 and CodeMirror 6, so both layout-lovers and keyboard-driven plain-text purists have a home.
- **AI-native experience**: Integrated DeepSeek, Gemini, OpenAI, and local Ollama, enabling AI-assisted writing and RAG-based Q&A over your knowledge base.
- **Detail-obsessed UX polish**: Recent releases have shipped weak-network character-loss protection, an end-to-end thumbnail pipeline powered by Sharp for image-dense scenarios (cutting per-page bandwidth by ~100×), a 4-tier privacy share flow with anonymous-guest comments, and one-click `.fpk` install support for fnOS, a popular self-hosted NAS ecosystem.

To be honest, I have a day job. But in this era where AI tools amplify developer productivity by orders of magnitude, I pour almost all my free time into this project. Watching the community group get livelier, watching issues get closed one by one — that sense of accomplishment is unmatched.

---

## V. The Future: A Hundred-Year Open-Source Promise

New users often ask me: *Will this project ever charge money? Is my data safe with you?*

My answer hasn't changed: **BaseForge is fully open-sourced under GPL-3.0. It does not belong to any company. It belongs to you and the community.**

What it advocates is **purely self-hosted deployment**. All your journals, ideas, daily ramblings, and knowledge live inside the SQLite database on *your* NAS or server. No cloud vendor can peek at your data, and no one can lock you out of your own assets.

My goal is to maintain this project for **a hundred years**. As long as our devices still get power, and as long as we still feel the urge to write things down, BaseForge will keep iterating.

If you're someone who loves tinkering with NAS, relies heavily on note-taking, and has high standards for digital privacy — come try it, give us feedback, file PRs, or join our community group (QQ: `1093473044`). Let's build this small private knowledge base into the digital safe haven that homelabbers deserve.

- **GitHub repository**: [Project repository](https://github.com/cropflre/nowen-note)
