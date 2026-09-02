# How ProsodyBall Measures Pitch (and Why It Does It That Way)

*Part of the "how the app actually works" series — no technical background needed.*

Pitch is the most obvious thing a voice training app can measure, and it's the one people
ask about first. "What number is my voice?" It turns out that getting an honest, stable
answer to that question is harder than it sounds, and most of the work in ProsodyBall's
pitch system isn't measuring pitch at all — it's deciding when *not* to.

Here's the whole thing, in plain language.

## What pitch actually is

When you make a voiced sound — a vowel, a hum, most of a normal sentence — your vocal folds
are opening and closing very fast. Each open-close cycle sends a little puff of air up
through your throat and out your mouth. If that happens 180 times a second, we say your
pitch is 180 Hz ("hertz" just means "times per second").

So pitch isn't a mysterious quality of your voice. It's a *repetition rate*. And that's the
key to measuring it: instead of asking "how high does this sound?", the app asks a much more
mechanical question — **how long is one repeat?**

## How the app finds the repeat

Several times a second, the app grabs a short slice of audio from the mic — about a tenth of
a second's worth. Then it plays a simple game of "slide and compare."

Imagine printing the sound wave on a strip of paper, making a copy, and sliding the copy
along the original. Most of the time the two won't line up — bumps sit on top of dips. But
if you slide by *exactly* one vocal fold cycle, the copy snaps into alignment with the
original, because that's the length of the pattern that repeats.

The app slides the copy across every plausible offset, scores how well each one lines up,
and takes the best match. If the best match is at, say, 1/180th of a second, your pitch is
180 Hz. This method has a name — YIN — and it's a standard in speech research, not something
invented here. It works directly on the raw wave, which makes it good at exactly what we
need: fast, low-latency, honest tracking of a single human voice.

The app only searches offsets that correspond to roughly 40–600 Hz. Nothing below that is a
human fundamental, and nothing above it is either — refusing to even consider the impossible
answers removes a whole category of mistakes.

## Two problems, and the fixes

**Problem one: the octave error.** Sometimes the copy also lines up decently at *twice* the
true repeat length, or half of it. When a detector falls for this, your voice appears to jump
a full octave for a fraction of a second — a spike on the display that never came out of your
mouth. The app handles this two ways. First, when it finds a candidate, it deliberately checks
the longer multiples of that repeat to see if one of them fits better; if so, it takes the
lower one. Second, it keeps the last handful of readings and uses the **middle** value rather
than the newest one. A single wild reading surrounded by sensible neighbours can't win a vote
like that, so it gets quietly discarded.

**Problem two: not everything is a voice.** A fan, a keyboard, a car outside, breath noise —
these all produce a "best match" if you ask for one, and the answer is meaningless. So every
slice of audio has to pass a gate before it counts. It must be louder than the room's measured
noise floor, and the alignment has to be genuinely good, not just the best of a bad set. How
good that alignment was becomes a **confidence** number, and confidence gates everything
downstream. Low confidence, and the app would rather show you nothing than show you a
confident-looking wrong number.

That's the design principle worth taking away: **a wrong number is worse than no number.**
If you're training toward a target and the display lies to you, you'll learn the lie.

## Why the displayed number moves smoothly

Raw pitch, measured many times a second, is jittery even in a perfectly steady voice. Showing
it unfiltered makes the display flicker and makes you chase noise. So the number you see eases
toward each new reading rather than snapping to it — and it eases *faster* when the app is
confident and slower when it isn't. When confidence drops below the threshold entirely, the
display simply holds still instead of being dragged around by garbage.

The app also tracks a second, slower number: your **habitual pitch** — the median of your
voiced frames over the last second and a half. Your momentary pitch is constantly moving,
because that's what speech is. Habitual pitch is where your voice *lives*, and that's the
number that's meaningful for training. It also reports how spread out those readings were,
which is its own way of saying "how sure am I about this."

## Why it learns your range instead of assuming one

Early in a session, the app spends a short while just listening and building a picture of
your personal range, throwing away the extreme top and bottom few percent (those are usually
errors, not you) and padding the rest a little. From then on, it searches your range rather
than the whole human range.

This matters for a reason that isn't obvious: the display would otherwise be measured against
a population average, which puts most people in a squashed sliver of the meter where nothing
they do looks like progress. Scaled to *your* range, a real change in your voice is a visible
change on screen.

It's also why pitch is handled on a musical scale rather than a straight numerical one.
Going from 100 Hz to 120 Hz and going from 200 Hz to 240 Hz are both a change of the same
musical size, even though one is 20 Hz and the other is 40 Hz. Your ear works in ratios, so
the app does too — spread is reported in semitones, the same unit a musician would use.

## And why the ball cares

In the game, pitch does two jobs. Where your pitch sits contributes to the ball's colour and
position. But how much your pitch *moves* is what makes the ball bounce — that's the prosody
half of ProsodyBall. A flat, monotone delivery produces a flat, sluggish ball no matter how
"correct" the pitch number is. That's deliberate. Hitting a target pitch and holding it dead
still isn't the goal; a voice that moves naturally is.

**Next in the series:** resonance — the measurement that's much less obvious than pitch, and
much more interesting.
