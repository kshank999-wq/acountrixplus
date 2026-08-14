/**
 * Every handler, imported for its registration side effect.
 *
 * The runner imports this module once. Registration by import is the one place
 * in this codebase where a side effect at module scope is the right shape —
 * the alternative is a list of handlers maintained in two files that disagree
 * the first time somebody adds one and forgets the other.
 *
 * Adding a handler is: write it, register it, add a line here.
 */
import './accounting'
import './banking'
import './housekeeping'
import './marketing'
import './notifications'

export {}
