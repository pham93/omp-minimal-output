// Deterministic visual fixtures for card renderers. This module has no plugin
// registration or timers; callers opt in by importing a fixture renderer.
import type { Container } from "@oh-my-pi/pi-tui";
import { renderWebSearchCard } from "./web-search-card.ts";

export const CARD_GALLERY_STATE = {
  running: "running",
  success: "success",
  error: "error",
  expanded: "expanded",
} as const;

export type CardGalleryState = (typeof CARD_GALLERY_STATE)[keyof typeof CARD_GALLERY_STATE];

export interface CardGalleryFixture {
  args: unknown;
  result: unknown;
  options: unknown;
  fingerprint: string;
}

export type CardGalleryFixtures = Record<CardGalleryState, CardGalleryFixture>;

export type CardGalleryRenderer = (theme: unknown, fixture: CardGalleryFixture) => Container;

export function renderCardGalleryFixture(
  renderer: CardGalleryRenderer,
  theme: unknown,
  state: CardGalleryState,
  fixtures: CardGalleryFixtures,
): Container {
  return renderer(theme, fixtures[state]);
}

const SAMPLE_SOURCES = [
  { title: "Oh My Pi documentation", url: "https://ohmy-pi.dev/docs" },
  { title: "Provider API reference", url: "https://provider.example/api" },
  { title: "Search result three", url: "https://example.test/three" },
  { title: "Search result four", url: "https://example.test/four" },
  { title: "Search result five", url: "https://example.test/five" },
  { title: "Search result six", url: "https://example.test/six" },
] as const;

export const WEB_SEARCH_GALLERY_FIXTURES = {
  [CARD_GALLERY_STATE.running]: {
    args: { query: "card gallery" },
    result: undefined,
    options: { isPartial: true },
    fingerprint: "card-gallery:web_search:running",
  },
  [CARD_GALLERY_STATE.success]: {
    args: { query: "card gallery" },
    result: {
      content: [{ type: "text", text: "Search completed" }],
      details: { response: { provider: "gallery", sources: SAMPLE_SOURCES.slice(0, 2) } },
    },
    options: {},
    fingerprint: "card-gallery:web_search:success",
  },
  [CARD_GALLERY_STATE.error]: {
    args: { query: "card gallery" },
    result: {
      isError: true,
      content: [{ type: "text", text: "Search failed" }],
      details: { error: "Gallery search failure", response: { provider: "gallery", sources: [] } },
    },
    options: { expanded: true },
    fingerprint: "card-gallery:web_search:error",
  },
  [CARD_GALLERY_STATE.expanded]: {
    args: { query: "card gallery" },
    result: {
      content: [{ type: "text", text: "Search completed" }],
      details: { response: { provider: "gallery", sources: SAMPLE_SOURCES } },
    },
    options: { expanded: true },
    fingerprint: "card-gallery:web_search:expanded",
  },
} as const satisfies CardGalleryFixtures;

function renderWebSearchGalleryFixture(theme: unknown, fixture: CardGalleryFixture): Container {
  return renderWebSearchCard(theme, fixture.args, fixture.result, fixture.options, fixture.fingerprint);
}

export function renderWebSearchGalleryCard(theme: unknown, state: CardGalleryState): Container {
  return renderCardGalleryFixture(renderWebSearchGalleryFixture, theme, state, WEB_SEARCH_GALLERY_FIXTURES);
}
