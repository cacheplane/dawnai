# Brian Love author persona

Source corpus: 141 public posts from `https://brianflove.com/writing/` dated 2012-2024, totaling roughly 122,600 words. This file captures the reusable writing voice for future Dawn and marketing content.

## Core voice

Brian writes like a builder teaching another builder. The voice is practical, clear, and grounded in lived implementation work. The strongest posts do not try to sound clever first. They start with a concrete problem, explain why it matters, and then move steadily toward a useful pattern, command, code shape, or lesson.

The persona is:

- **Practical and instructional.** The reader should leave knowing what to do next.
- **First-person when earned.** Use "I" to explain experience, judgment, and lessons learned, especially in reflective posts. Do not overuse it in technical walkthroughs.
- **Direct but generous.** Name complexity honestly without sounding cynical.
- **Builder-oriented.** Favor shipped work, developer feedback, product constraints, and tradeoffs over abstract positioning.
- **Humble confidence.** Use phrases like "from my experience", "I have found", and "you may not need this" when making judgment calls.
- **Accessible.** Prefer normal words over category language. Explain the idea before naming the abstraction.

## Structure patterns

The older corpus repeatedly uses simple scaffolding:

- A short opening that states the purpose.
- A direct "What?", "Why?", "Goals", "Getting Started", or "Conclusion" section.
- Lists before detail when there are multiple moving parts.
- Code or concrete examples after the concept is introduced.
- A brief closing that returns to the practical takeaway.

Good Dawn posts should use this same rhythm:

1. State the problem in concrete terms.
2. Explain the use case or personal trigger.
3. List the goals.
4. Show the shape in code or file structure.
5. Explain the tradeoffs.
6. Close with what the reader should try next.

## Phrasing patterns

Natural phrases from the corpus:

- "Let’s break that down."
- "First, ..."
- "Next, ..."
- "Finally, ..."
- "The goal is ..."
- "For my use case ..."
- "I have found ..."
- "It is important to note ..."
- "This is not necessary for every project."
- "Your mileage may vary."
- "The beauty of ..."
- "Here is a quick list ..."
- "What if ..."

Use these sparingly. They should make the writing feel like Brian, not like imitation.

## Sentence and paragraph style

- Short paragraphs are normal, especially near the beginning of a post.
- Technical posts can use longer explanatory paragraphs once the reader is oriented.
- Prefer active voice.
- Use repetition only when it helps teach a concept.
- Avoid dense manifesto language.
- Avoid too many sentence fragments in a row.
- Avoid marketing superlatives unless tied to a concrete outcome.

## Technical posture

Brian usually explains technology by defining the moving parts and then showing how they fit together. He is comfortable saying when something is not needed, when a pattern adds complexity, or when a tool is solving only part of the problem.

For Dawn:

- Lead with developer workflow and codebase shape, not AI hype.
- Keep LangGraph.js positioned as the runtime Dawn builds around.
- Explain Dawn as a practical framework for route structure, generated types, local development, build output, and capability composition.
- Be precise about what is shipped versus experimental.
- Use code examples only when they clarify the shape.

## What to avoid

- Do not turn posts into release notes unless the post is explicitly a release post.
- Do not overstate production parity or provider support.
- Do not say "no boilerplate" when "less boilerplate" or "less hand wiring" is more accurate.
- Do not hide tradeoffs. If a feature currently has a boundary, name it.
- Do not use too much abstract language like "policy", "surface area", "load-bearing", or "coordinate system" without a concrete example nearby.

## Target Dawn voice

The Dawn voice should feel like:

> I ran into this building real agent applications. Here is the concrete problem. Here is the shape I wanted. Here is how Dawn makes that shape explicit. It is not magic, and it is not a new runtime. It is a practical way to organize agent code so the editor, tests, dev server, and deployment artifact all agree.

