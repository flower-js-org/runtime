/* Flower extension translation unit. Upstream remains byte-for-byte pinned.
 * The validator uses private property inspection solely to avoid executing
 * application getters while determining whether the fast path is equivalent.
 * SPDX-License-Identifier: MIT */
#include "upstream/quickjs.c"
#include "json-check.c"
#include "canonical-json.c"
#include "read-json.c"
#include "crypto-view.c"
