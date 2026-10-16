// shared by the page and the service worker that plays its API
export const CART = [
  { name: "Mechanical keyboard", price: 129 },
  { name: "USB-C cable", price: 15 },
];

export type Item = (typeof CART)[number];

// the page asks an already active worker to take control of it
export const CLAIM = "claim";
