/**
 * The panel's two languages.
 *
 * The rule is the same one the theme follows: a Chinese reader gets Chinese, an
 * English reader gets English. The difference is *where the choice comes from*.
 * A static site fixes its language at build time, because the page is written
 * once and served many times. The panel is a running application talking to a
 * person who may write in one language and read the interface in another — so
 * the language is a property of the session, detected from the browser and
 * switchable in the top bar.
 *
 * The English copy deliberately borrows the theme's own words — Shelf, Recently,
 * Reading / Watching / Listening, Pinned — so a reader moving between the site
 * and the panel is not asked to learn two vocabularies for the same thing.
 */

export type Lang = 'zh' | 'en'

/** Text that varies by count. Kept as a function so word order stays per-language. */
export type Plural = (count: number) => string

export interface Dictionary {
  // --- Shell -------------------------------------------------------------
  'app.name': string
  /** The wordmark, for a place too narrow for the full name. */
  'app.shortName': string
  'app.tagline': string

  'nav.posts': string
  'nav.pages': string
  'nav.shelf': string
  'nav.config': string
  'nav.media': string
  'nav.tasks': string
  'nav.history': string
  'nav.audit': string
  'nav.overview': string
  'nav.sites': string
  'nav.users': string

  'nav.more': string
  'nav.aria.sections': string
  'nav.aria.location': string
  'nav.aria.sites': string
  'nav.aria.users': string
  'nav.aria.backToOverview': string
  'nav.aria.theme': string

  'shell.connecting': string
  'shell.roleOwner': string
  'shell.roleEditor': string
  'shell.panelTitle': string
  'shell.loadFailed': string
  'shell.needAccess': string
  'shell.needConfig': string
  'shell.checkNetwork': string

  // --- Shared words ------------------------------------------------------
  'common.save': string
  'common.saving': string
  'common.cancel': string
  'common.delete': string
  'common.edit': string
  'common.add': string
  'common.close': string
  'common.retry': string
  'common.loading': string
  'common.reading': string
  'common.confirm': string
  'common.up': string
  'common.remove': string
  'common.none': string
  'common.optional': string
  'common.required': string
  'common.empty': string
  'common.noChange': string
  'common.saved': string
  'common.search': string
  'common.time': string

  // --- Posts -------------------------------------------------------------
  'posts.title': string
  'posts.subtitle': (loaded: boolean, total: number, pinned: number, drafts: number) => string
  'posts.importMd': string
  'posts.newPost': string
  'posts.searchPlaceholder': string
  'posts.searchAria': string
  'posts.allTags': string
  'posts.filterTag': string
  'posts.allStatus': string
  'posts.allLanguages': string
  'posts.filterStatus': string
  'posts.filterLanguage': string
  'posts.published': string
  'posts.draft': string
  'posts.selected': (count: number) => string
  'posts.publish': string
  'posts.unpublish': string
  'posts.pin': string
  'posts.unpin': string
  'posts.clearSelection': string
  'posts.noMatch': string
  'posts.noMatchHint': string
  'posts.empty': string
  'posts.emptyHint': string
  'posts.writeFirst': string
  'posts.listCaption': string
  'posts.colTitle': string
  'posts.colDate': string
  'posts.colWords': string
  'posts.colStatus': string
  'posts.selectAll': string
  'posts.selectOne': (title: string) => string
  'posts.pinnedOn': (weight: number) => string
  'posts.markedPinned': string
  'posts.mdOnly': string
  'posts.tooBig': (name: string) => string
  'posts.imported': (count: number) => string
  'posts.rejected': (count: number) => string
  'posts.conflicts': (count: number) => string
  'posts.nothingToImport': string
  'posts.conflictList': (list: string) => string
  'posts.deleteTitle': (count: number) => string
  'posts.deleteBody': string
  'posts.batchDone': (label: string, count: number) => string

  // --- Editor ------------------------------------------------------------
  'editor.new': string
  'editor.edit': string
  'editor.newHint': string
  'editor.opening': string
  'editor.slug': string
  'editor.slugHint': string
  'editor.title': string
  'editor.description': string
  'editor.tags': string
  'editor.tagsPlaceholder': string
  'editor.pin': string
  'editor.draft': string
  'editor.draftHint': string
  'editor.lang': string
  'editor.langHint': string
  'editor.writeMd': string
  'editor.langZh': string
  'editor.langEn': string
  'editor.paneWrite': string
  'editor.panePreview': string
  'editor.paneAria': string
  'editor.importIntoEditor': string
  'editor.save': string
  'editor.delete': string
  'editor.download': string
  'editor.previewUnavailable': string

  // --- Pages -------------------------------------------------------------
  'pages.title': string
  'pages.subtitle': string
  'pages.about': string
  'pages.now': string
  'pages.friends': string
  'pages.loading': string
  'pages.notYet': (name: string) => string
  'pages.create': string
  'pages.created': string

  // --- Shelf -------------------------------------------------------------
  'shelf.title': string
  'shelf.subtitle': string
  'shelf.fillCovers': string
  'shelf.books': string
  'shelf.films': string
  'shelf.music': string
  'shelf.missingCovers': (count: number) => string
  'shelf.completeThis': string
  'shelf.add': string
  'shelf.empty': (name: string) => string
  'shelf.emptyHint': string
  'shelf.fieldsHint': string
  'shelf.noCreator': string

  // --- Config ------------------------------------------------------------
  'config.title': string
  'config.subtitle': string
  'config.tabSite': string
  'config.tabNav': string
  'config.tabTheme': string
  'config.tabFeatures': string
  'config.tabRaw': string
  'config.siteName': string
  'config.subtitleField': string
  'config.description': string
  'config.author': string
  'config.email': string
  'config.url': string
  'config.urlHint': string
  'config.uiLang': string
  'config.uiLangHint': string
  'config.uiLangUnavailable': string
  'config.docLang': string
  'config.docLangHint': string
  'config.locale': string
  'config.startYear': string
  'config.perPage': string
  'config.ga': string
  'config.gaPlaceholder': string
  'config.tocOpen': string
  'config.nav': string
  'config.navHint': string
  'config.navKeyTitle': string
  'config.addCustomNav': string
  'config.socials': string
  'config.external': string
  'config.addSocial': string

  // --- Media -------------------------------------------------------------
  'media.title': string
  'media.subtitle': string
  'media.images': string
  'media.shelf': string
  'media.music': string
  'media.og': string
  'media.folderAria': string
  'media.upload': string
  'media.empty': string
  'media.emptyHint': string
  'media.deleteConfirm': (name: string) => string
  'media.sizeLimit': (name: string) => string
  'media.totalLimit': string
  'media.uploaded': (count: number) => string
  'media.referenced': (count: number) => string
  'media.notReferenced': string
  'media.copied': string
  'media.copyFailed': (text: string) => string
  'media.uploading': string
  'media.limits': string
  'media.copy': string
  'media.view': string
  'common.deleted': string

  // --- Tasks -------------------------------------------------------------
  'tasks.title': string
  'tasks.subtitle': string
  'tasks.install': string
  'tasks.installTitle': string
  'tasks.notInstalled': string
  'tasks.notInstalledHint': string
  'tasks.selectTask': string
  'tasks.argsPlaceholder': string
  'tasks.argsAria': string
  'tasks.run': string
  'tasks.running': string
  'tasks.commits': string
  'tasks.empty': string
  'tasks.emptyHint': string
  'tasks.started': string
  'tasks.cancelled': string
  'tasks.details': string
  'tasks.collapse': string
  'tasks.logs': string
  'tasks.cancel': string
  'tasks.failedStep': (name: string) => string
  'tasks.failed': string
  'tasks.mismatch': string
  'tasks.ready': string
  'tasks.installed': string

  // --- History / audit ---------------------------------------------------
  'history.title': string
  'history.subtitle': string
  'history.empty': string
  'history.colMessage': string
  'audit.title': string
  'audit.subtitle': string
  'audit.empty': string
  'audit.emptyHint': string
  'audit.colAction': string
  'audit.colTarget': string
  'audit.colCommit': string
  'audit.colWho': string

  // --- Sites -------------------------------------------------------------
  'sites.title': string
  'sites.subtitle': string
  'sites.connect': string
  'sites.empty': string
  'sites.emptyOwner': string
  'sites.emptyEditor': string
  'sites.enter': string
  'sites.disconnect': string
  'sites.disconnectTitle': (name: string) => string
  'sites.disconnectBody': string
  'sites.noPublicUrl': string
  'sites.connectTitle': string
  'sites.editTitle': string
  'sites.displayName': string
  'sites.owner': string
  'sites.repo': string
  'sites.branch': string
  'sites.publicUrl': string
  'sites.publicUrlHint': string
  'sites.patRef': string
  'sites.patRefHint': string
  'sites.token': string
  'sites.tokenSave': string
  'sites.tokenHint': string
  'sites.check': string
  'sites.checkOk': string
  'sites.checkPartial': string

  // --- Users -------------------------------------------------------------
  'users.title': string
  'users.subtitle': string
  'users.emailPlaceholder': string
  'users.emailAria': string
  'users.roleAria': string
  'users.add': string
  'users.removeTitle': (email: string) => string
  'users.removeBody': string
  'users.colEmail': string
  'users.colRole': string
  'users.colLastSeen': string
  'users.you': string
  'users.never': string
  'users.added': string
  'users.removed': string

  // --- Overview ----------------------------------------------------------
  'overview.title': string
  'overview.subtitle': string

  'overview.running': (arg0: number) => string
  'overview.failures': (arg0: number) => string
  'overview.noSites': string
  'overview.connectOne': string
  'overview.noSitesHint': string
  'overview.colSite': string
  'overview.colRepo': string
  'overview.colLastTask': string
  'overview.canDo': string
  'overview.doPosts': string
  'overview.doPages': string
  'overview.doShelf': string
  'overview.doConfig': string
  'overview.doMedia': string
  'overview.doTasks': string
  'pages.aria': string
  'pages.aboutHint': string
  'pages.nowHelp': string
  'pages.friendsHelp': string
  'pages.name': string
  'pages.url': string
  'pages.note': string
  'pages.label': string
  'pages.creator': string
  'pages.year': string
  'pages.douban': string
  'pages.link': string
  'pages.delete': string
  'pages.add': string
  'pages.deleteTitle': (arg0: string) => string
  'editor.titleField': string
  'editor.descriptionField': string
  'editor.descriptionPlaceholder': string
  'editor.slugPlaceholder': string
  'editor.saveHint': string
  'editor.created': string
  'editor.createdSlug': (arg0: string) => string
  'editor.conflict': string
  'editor.noChange': string
  'editor.saved': string
  'editor.deleteTitle': (arg0: string) => string
  'editor.deleteBody': string
  'editor.deleted': string
  'editor.unsaved': string
  'shelf.kindBook': string
  'shelf.kindFilm': string
  'shelf.kindMusic': string
  'shelf.addTitle': string
  'shelf.editTitle': (arg0: string) => string
  'shelf.fieldTitle': string
  'shelf.fieldCreator': string
  'shelf.fieldYear': string
  'shelf.fieldDouban': string
  'shelf.fieldLink': string
  'shelf.fieldNote': string
  'shelf.updated': string
  'shelf.added': string
  'shelf.deleted': string
  'shelf.coverTaskStarted': string
  'shelf.deleteTitle': (arg0: string) => string
  'shelf.deleteBody': string
  'shelf.noCover': string
  'shelf.cover': string
  'sites.connected': string
  'sites.checklist': string
  'sites.tokenSaved': string
  'sites.repoFiles': string
  'sites.tokenIdentity': string
  'sites.structConfig': string
  'sites.structPosts': string
  'sites.structChannel': string
  'sites.channelMissing': string
  'tasks.argsAriaLabel': string
  'tasks.installConfirmUpdate': string
  'tasks.installConfirmNew': string
  'tasks.update': string
  'tasks.installAction': string
  'tasks.failedLabel': string
  'tasks.success': string
  'tasks.queued': string
  'tasks.inProgress': string
  'tasks.unknown': string
  'tasks.noCommit': string
  'config.themeDefaultMode': string
  'config.themeLight': string
  'config.themeDark': string
  'config.contrast': string
  'config.featuresHint': string
  'config.rawHint': string
  'config.savedNav': string
  'users.subtitleLong': string
  'pages.description': string
  'pages.body': string
  'pages.bodyHint': string
  'pages.nowEmpty': string
  'pages.nowEmptyHint': string
  'pages.removeTitle': (arg0: string) => string
  'pages.removeBody': string
  'pages.parseError': (arg0: string) => string
  'pages.moveUp': (arg0: string) => string
  'pages.moveDown': (arg0: string) => string
  'pages.notePlaceholder': string
  'pages.addFriend': string
  'shell.switchToEn': string
  'shell.switchToZh': string
  'shell.langShortEn': string
  'shell.langShortZh': string
  'history.colAuthor': string
  'diff.large': string
  'diff.renamedBefore': string
  'diff.renamedAfter': string
  'diff.skippedAria': (arg0: number) => string
  'diff.skipped': (arg0: number) => string
  'diff.added': string
  'diff.removed': string
  'diff.same': string
  'diff.more': (arg0: number) => string
  'users.roleEditor': string
  'users.roleOwner': string
  'nav.sections': string
  'nav.current': string
  'status.cancelled': string
  'status.unknown': string
  'shell.notifications': string
  'shell.dismissToast': string
  'time.justNow': string
  'time.minutesAgo': (arg0: number) => string
  'time.hoursAgo': (arg0: number) => string
  'time.daysAgo': (arg0: number) => string
  'time.seconds': (arg0: number) => string
  'time.minutesSeconds': (arg0: number, arg1: number) => string
  'tasks.updateChannelTitle': string
  'tasks.emptyHintPre': string
  'tasks.emptyHintMid': string
  'tasks.emptyHintEnd': string
  'tasks.noSteps': string
  'tasks.changedFiles': string
  'tasks.fileAdded': string
  'tasks.fileRemoved': string
  'tasks.fileModified': string
  'tasks.stepDone': string
  'tasks.stepFailed': string
  'tasks.stepSkipped': string
  'tasks.stepCancelled': string
  'common.working': string
  'shelf.coverStarted': string
  'shelf.runCovers': string
  'shelf.runCoversFor': (arg0: string) => string
  'common.yes': string
  'sites.disconnected': string
  'sites.patRefPlaceholder': string
  'sites.fileCount': (arg0: number) => string
  'sites.namePlaceholder': string
  'editor.bodyPlaceholder': string
  'editor.saveTitle': (arg0: number, arg1: number) => string
  'editor.confirmSave': string
  'editor.lookAgain': string
  'editor.loaded': (arg0: string) => string
  'editor.meta': (arg0: number, arg1: number, arg2: string) => string
  'editor.create': string
  'editor.checkAndSave': string
  'editor.slugField': string
  'editor.slugFieldHint': string
  'editor.published': string
  'editor.previewTitle': string
  'config.saved': string
  'config.savedTheme': string
  'config.savedFeatures': string
  'config.aria': string
  'config.defaultMode': string
  'config.modeAuto': string
  'config.modeLight': string
  'config.modeDark': string
  'config.paletteDay': string
  'config.paletteNight': string
  'config.contrastAria': string
  'config.contrastLow': string
  'config.colourAria': (arg0: string) => string
  'config.valueAria': (arg0: string) => string
  'config.label': string
  'config.href': string
  'config.rawWriteTitle': string
  'config.rawWriteBody': string
  'config.rawWrite': string
  'config.rawWritten': string
  'config.rawAria': string
  'config.rawWriting': string
  'config.rawWriteButton': string
  'config.featureSearch': string
  'config.featureViews': string
  'config.featureMusicCards': string
  'config.featureGithubCards': string
  'config.featureMediaEmbeds': string
  'config.featureMath': string
  'config.featureMermaid': string
  'error.BODY_REQUIRED': string
  'error.CONFIG_COLOR': string
  'error.CONFIG_PATH': string
  'error.CONTENT': string
  'error.JWK_SHAPE': string
  'error.JWKS_EMPTY': string
  'error.JWKS_HTTP': string
  'error.JWKS_NETWORK': string
  'error.JWT_ALG': string
  'error.JWT_EMAIL': string
  'error.JWT_ISS': string
  'error.JWT_KID': string
  'error.JWT_MALFORMED': string
  'error.JWT_NBF': string
  'error.JWT_SIGNATURE': string
  'error.NAMESPACE': string
  'error.NO_SESSION_SECRET': string
  'error.NONE': string
  'error.NOT_CONFIGURED': string
  'error.PAGE_EXISTS': string
  'error.PAGE_MISSING': string
  'error.PATH_ABSOLUTE': string
  'error.PATH_CHARS': string
  'error.PATH_EMPTY': string
  'error.PATH_ENCODING': string
  'error.PATH_FORBIDDEN': string
  'error.PATH_MEDIA': string
  'error.PATH_RESERVED': string
  'error.PATH_TOO_LONG': string
  'error.PATH_TRAVERSAL': string
  'error.POST_EXISTS': string
  'error.PROJECT': string
  'error.PUBLISHED': string
  'error.SESSION_SECRET': string
  'error.SHA_REQUIRED': string
  'error.SITE_BRANCH': string
  'error.SITE_DISABLED': string
  'error.SITE_EXISTS': string
  'error.SITE_NAME': string
  'error.SITE_OWNER': string
  'error.SITE_PAT_REF': string
  'error.SITE_REPO': string
  'error.SITE_TOKEN': string
  'error.SLUG': string
  'error.TASK_BUDGET': string
  'error.TASK_DONE': string
  'error.TASK_KIND': string
  'error.TASK_NO_RUN': string
  'error.TASK_PERMISSION': string
  'error.TOKEN_DECRYPT': string
  'error.TOKEN_SHAPE': string
  'taskKind.covers': string
  'taskKind.music': string
  'taskKind.og': string
  'taskKind.build': string
  'taskKind.build:clean': string
  'taskKind.clean': string
  'taskKind.shots': string
  'taskKind.test:shelf': string
  'taskKind.test:render': string
  'taskKind.test:font-source': string
  // --- Errors returned by the Worker -------------------------------------
  // The Worker answers with a `code`; these are what the reader sees.
  'error.INTERNAL': string
  'error.NOT_FOUND': string
  'error.NETWORK': string
  'error.HTTP': string
  'error.CONFLICT': string
  'error.RATE_LIMIT': string
  'error.CSRF_ORIGIN': string
  'error.CSRF_HEADER': string
  'error.CSRF_TOKEN': string
  'error.HOST': string
  'error.CONFIG': string
  'error.ROLE': string
  'error.AUTH': string
  'error.RATE_LIMIT_GITHUB': string
  'error.FORBIDDEN': string
  'error.BODY_JSON': string
  'error.BODY_TOO_LARGE': string
  'error.PATH': string
  'error.EMPTY': string
  'error.TOO_MANY': string
  'error.TOO_LARGE': string
  'error.FORMAT': string
  'error.PIXELS': string
  'error.MEDIA_FOLDER': string
  'error.MEDIA_NAME': string
  'error.MEDIA_TYPE': string
  'error.SITE_NOT_FOUND': string
  'error.SITE_URL': string
  'error.TASK_NOT_FOUND': string
  'error.EMAIL': string
  'error.SELF': string
  'error.LAST_OWNER': string
  'error.SHELF_MISSING': string
  'error.TITLE': string
  'error.CONFIG_SHAPE': string
  'error.CONFIG_PARSE': string
  'error.CONFIG_VALUE': string
  'error.CONFIG_MISSING': string
  'error.CONFIG_COMPLEX': string
  'error.SVG_SCRIPT': string
  'error.SVG_FOREIGN': string
  'error.SVG_JS_URL': string
  'error.FRONTMATTER': string
  'error.TASK_ARGS': string
  'error.TASK_CHANNEL': string
  'error.TREE_TRUNCATED': string
  'error.JWT_EXPIRED': string
  'error.JWT_AUD': string
  'error.NO_TOKEN': string
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

import { createContext } from 'preact'
import { useContext } from 'preact/hooks'
import { en } from './i18n.en'
import { zh } from './i18n.zh'

/** Both dictionaries, keyed by language. */
export const dictionaries: Record<Lang, Dictionary> = { zh, en }

const STORAGE_KEY = 'onpaper-admin-lang'

/**
 * The language to start in.
 *
 * The browser's own preference is the honest default: someone who runs their
 * laptop in English and writes Chinese posts should get an English panel. A
 * stored choice wins over it, because the person made that choice explicitly.
 */
export function detectLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'zh' || stored === 'en') return stored
  }
  catch {
    // A private window can refuse localStorage; fall through to the browser.
  }
  const languages = typeof navigator !== 'undefined'
    ? [navigator.language, ...(navigator.languages ?? [])]
    : []
  // `zh-TW`, `zh-Hans-CN` and `zh` are all Chinese; anything else is English.
  return languages.some(tag => /^zh\b/i.test(tag ?? '')) ? 'zh' : 'en'
}

export function rememberLang(lang: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang)
  }
  catch {
    // Not being able to remember the choice must not break the switch.
  }
}

export interface I18n {
  lang: Lang
  /** A string, or the string a plural function returns for this count. */
  t: (key: keyof Dictionary, ...args: unknown[]) => string
}

export const I18nContext = createContext<I18n>({ lang: 'zh', t: (key) => String(key) })

/** The translator for the current screen. */
export function useT(): I18n {
  return useContext(I18nContext)
}

/**
 * Build the translator for a language.
 *
 * A missing key returns the key itself rather than throwing: a blank label in
 * production is worse than a visible `posts.colTitle`, which says exactly what
 * is missing and where.
 */
export function translator(lang: Lang): I18n['t'] {
  const dict = dictionaries[lang] ?? dictionaries.zh
  return (key, ...args) => {
    const value = dict[key] as unknown
    if (typeof value === 'function') return String((value as Plural)(...(args as [number])))
    if (typeof value === 'string') return value
    return String(key)
  }
}
