/**
 * Entry point.
 *
 * Styles are imported before the app so the first paint is already the final
 * one — no flash of unstyled panel behind an Access redirect.
 */

import { render } from 'preact'
import './styles/tokens.css'
import './styles/base.css'
import './styles/views.css'
// Last on purpose: these override the two above by load order.
import './styles/phone.css'
import { App } from './app'

const root = document.getElementById('app')
if (!root) throw new Error('#app is missing from index.html')

render(<App />, root)
