// Big-screen storytelling while the attract loop plays: one large, calm caption card per beat (cross-fading
// as the loop moves on), progress dots, and a subtle "Touch the screen to try it yourself →" call to action.
import type { StoryCard } from '../attract/attract';

export function StoryCaption({ card }: { card: StoryCard }) {
  return (
    <div className={`ms-story ms-story-${card.tone}`} aria-live="polite">
      <span className="ms-story-kicker">
        <i aria-hidden="true" />
        Live demo · running by itself
      </span>
      {/* key: a new beat re-mounts the text, which runs the (motion-safe) entrance */}
      <div key={card.stepId} className="ms-story-text">
        <h2 className="ms-story-headline">{card.headline}</h2>
        {card.sub && <p className="ms-story-sub">{card.sub}</p>}
      </div>
      <ol className="ms-story-dots" aria-label={`Step ${card.index + 1} of ${card.count}`}>
        {Array.from({ length: card.count }, (_, i) => (
          <li key={i} className={i < card.index ? 'ms-dot-done' : i === card.index ? 'ms-dot-now' : ''} />
        ))}
      </ol>
    </div>
  );
}

export function TouchCta({ strong, onTouch }: { strong: boolean; onTouch?: () => void }) {
  const text = (
    <>
      Touch the screen to try it yourself <span aria-hidden="true">→</span>
    </>
  );
  return onTouch ? (
    <button type="button" className={`ms-cta${strong ? ' ms-cta-strong' : ''}`} onClick={onTouch}>
      {text}
    </button>
  ) : (
    <div className={`ms-cta${strong ? ' ms-cta-strong' : ''}`}>{text}</div>
  );
}
