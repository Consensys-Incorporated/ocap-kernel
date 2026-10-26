import {
  insistERef,
  insistEndpointId,
  insistGCAction,
  insistKRef,
  insistRRef,
  insistRemoteId,
  insistSubclusterId,
  insistVRef,
  insistVatId,
} from '../src/types.ts';
import type {
  ERef,
  EndpointId,
  GCAction,
  KRef,
  RRef,
  RemoteId,
  SubclusterId,
  VRef,
  VatId,
} from '../src/types.ts';

/**
 * Make a function that brands a test literal after checking it with the
 * kernel's own assertion, so a malformed literal fails the test instead of
 * passing as the brand.
 *
 * @param insist - The assertion for the branded type.
 * @returns The branding function.
 */
const makeBrander =
  <Brand extends string>(insist: (value: unknown) => asserts value is Brand) =>
  (value: string): Brand => {
    insist(value);
    return value;
  };

export const asVatId = makeBrander<VatId>(insistVatId);
export const asRemoteId = makeBrander<RemoteId>(insistRemoteId);
export const asEndpointId = makeBrander<EndpointId>(insistEndpointId);
export const asSubclusterId = makeBrander<SubclusterId>(insistSubclusterId);
export const asKRef = makeBrander<KRef>(insistKRef);
export const asVRef = makeBrander<VRef>(insistVRef);
export const asRRef = makeBrander<RRef>(insistRRef);
export const asERef = makeBrander<ERef>(insistERef);
export const asGCAction = makeBrander<GCAction>(insistGCAction);
