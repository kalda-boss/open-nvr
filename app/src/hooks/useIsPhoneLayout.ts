// Copyright (c) 2026 OpenNVR
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMediaQuery } from './useMediaQuery'

/**
 * A phone: narrower than Tailwind's `md`, or a touch screen too short to be
 * anything else. The second clause catches phones in landscape, which are
 * 844–932px wide; iPads are taller than 500px and keep the desktop layouts.
 */
export const PHONE_LAYOUT_QUERY = '(max-width: 767px), (pointer: coarse) and (max-height: 500px)'

export function useIsPhoneLayout(): boolean {
  return useMediaQuery(PHONE_LAYOUT_QUERY)
}
