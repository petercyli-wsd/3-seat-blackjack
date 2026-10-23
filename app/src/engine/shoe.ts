import { type Card, freshDecks } from "./cards";
import { type Rng, cryptoRng } from "./rng";
import { RULES } from "./rules";

export class Shoe {
  private cards: Card[] = [];
  private pos = 0;
  private cut = 0;
  /** Cards queued by a demo scenario; drawn before the shuffled shoe. */
  private forced: Card[] = [];
  shuffles = 0;

  constructor(private rng: Rng = cryptoRng) {
    this.shuffle();
  }

  shuffle() {
    const c = freshDecks(RULES.decks);
    for (let i = c.length - 1; i > 0; i--) {
      const j = this.rng.int(i + 1);
      [c[i], c[j]] = [c[j], c[i]];
    }
    this.cards = c;
    this.pos = 0;
    const span = RULES.cutCardMax - RULES.cutCardMin + 1;
    this.cut = c.length - (RULES.cutCardMin + this.rng.int(span));
    this.shuffles++;
  }

  /** Reshuffle between rounds once the cut card has come out. */
  get needsShuffle() {
    return this.pos >= this.cut;
  }

  get remaining() {
    return this.cards.length - this.pos;
  }

  get penetration() {
    return this.pos / this.cut;
  }

  force(cards: Card[]) {
    this.forced = [...cards];
  }

  draw(): Card {
    if (this.forced.length) return this.forced.shift()!;
    if (this.pos >= this.cards.length) this.shuffle();
    return this.cards[this.pos++];
  }
}
