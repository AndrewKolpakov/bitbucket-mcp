# bitbucket-mcp: анализ проблем pagination и sorting

Дата: 2026-07-25. Чекаут: `MatanYemini/bitbucket-mcp`, HEAD `d3594e2` (main, версия в
`package.json` — 5.0.7). Разбор ведётся против того, что реально запускается локально:
`~/.claude/scripts/mcp-bitbucket.sh` → `npx -y bitbucket-mcp@latest`.

---

## 0. Главное: рантайм отстаёт от main на 5 коммитов

`npm dist-tags` → `latest: 5.0.6` (опубликован 2025-12-22). В main лежит 5.0.7 и он **не
опубликован**. Коммиты, которых нет в вашем рантайме:

| Коммит | PR | Что |
| --- | --- | --- |
| `c8509d0` | #84 | **`sort` для `listPipelineRuns`** |
| `e1b2f50` | #105 | resolve body + threading комментариев |
| `7f765e6` | #99 | fix пустого body в POST |
| `3adcc91` | #73 | fix 400 в `approvePullRequest` с API-токенами |
| `d3594e2` | #92 | dotenv |

Проверено по распакованному тарболу 5.0.6: `grep params.sort dist/index.js` → пусто.
Схема живого MCP-инструмента `listPipelineRuns` в текущей сессии тоже без `sort`.

Апстрим-issue **#130** об этом уже открыт и висит.

**Вывод:** значительная часть «проблем с сортировкой» — это не баг кода, а неопубликованный
релиз. Первое и самое дешёвое исправление — перестать брать пакет из npm.

---

## 1. Sorting

### 1.1 `sort` есть ровно у одного инструмента, и то только в main

`grep -n sort src/index.ts` даёт три места и все они — `listPipelineRuns`
(`src/index.ts:1351`, `:3897`, `:3916`). Ни у одного из остальных list-инструментов
параметра `sort` нет:

`getPullRequests`, `listRepositories`, `getPullRequestComments`, `getPullRequestActivity`,
`getPullRequestCommits`, `getPullRequestTasks`, `getPullRequestStatuses`.

Bitbucket Cloud поддерживает query-фреймворк `q` + `sort` на большинстве коллекций
(`sort=-updated_on` и т. п.). Ни `sort`, ни `q` (кроме `q=name~"..."` в `listRepositories`)
наружу не выведены — фильтровать/сортировать приходится, вытягивая всё и разбирая на
стороне клиента.

### 1.2 Дефолтный порядок pipelines — по возрастанию, «последние прогоны» недостижимы

Эмпирическая проверка (`listPipelineRuns`, `managegocom/ai-chat`, `pagelen: 3`) вернула
`build_number` 1, 2, 3 с `created_on` 2026-06-01 / 06-02 — **самые старые прогоны репозитория**.

Практическое следствие: типовой запрос «покажи последний упавший пайплайн» без `sort`
невыполним в принципе — нужно либо угадывать номер последней страницы, либо тянуть всё.
Это же описано в закрытом issue #61.

**Правка:** после перехода на main выставить `sort` дефолт `-created_on`, если параметр не
передан (`src/index.ts:3916`). Иначе даже на 5.0.7 дефолтный вызов остаётся бесполезным.

### 1.3 `getPendingReviewPRs`: сортировка после обрезки

`src/index.ts:3841-3846`:

```ts
const finalResults = pendingPRs
  .slice(0, limit)          // сначала режем
  .sort((a, b) => new Date(b.updated_on) - new Date(a.updated_on));  // потом сортируем
```

Top-N по дате обновления считается неверно: берутся произвольные N в порядке обхода
репозиториев и сортируются уже они. Усугубляется досрочными `break` по достижении `limit`
(`:3829-3837`) — состав выборки зависит от порядка репозиториев в воркспейсе.
**Правка:** `sort(...).slice(0, limit)`.

---

## 2. Pagination

### 2.1 Тихая обрезка — корневая проблема

Из 10 публичных инструментов с пагинацией метаданные возвращает **только**
`getPullRequestStatuses` (`src/index.ts:4899-4907`). Остальные девять отдают голый
`JSON.stringify(result.values)`:

`listRepositories:2345`, `getPullRequests:2463`, `getPullRequestActivity:2693`,
`getPullRequestComments:2922`, `getPullRequestCommits:3030`, `listPipelineRuns:3933`,
`getPipelineSteps:4148`, `getPullRequestDiffStat:4604`, `getPullRequestTasks:4691`.

Клиент не может отличить «всего 10 комментариев» от «10 из 340». Именно поэтому в рабочих
инструкциях приходится держать памятку «всегда передавай `all: true`» — это обход симптома.

**Правка:** единый враппер для всех десяти:

```ts
{ values, page, pagelen, next, previous, fetchedPages, totalFetched, hasMore, truncated }
```

### 2.2 В режиме `all` теряется признак незавершённости

`src/pagination.ts:141-148` — ветка `all` возвращает `page/pagelen/previous/fetchedPages/
totalFetched`, но **не** `next`. При упоре в кап `BITBUCKET_ALL_ITEMS_CAP = 1000`
(`:118-125`, `:137-139`) факт обрезки виден только в debug-логе. То есть даже единственный
инструмент, отдающий метаданные, при `all: true` рапортует `next: undefined` на усечённом
результате.

**Правка:** возвращать `next` последней страницы и явный `truncated: true`.

### 2.3 `all` молча игнорируется вместе с `page`

`src/pagination.ts:64`: `const shouldFetchAll = all === true && page === undefined;`

`{ all: true, page: 2 }` тихо деградирует до одной страницы. Ни ошибки, ни предупреждения.
**Правка:** либо `InvalidParams`, либо поле `warning` в ответе.

### 2.4 `limit` работает как `pagelen`, а не как «сколько всего вернуть»

`src/index.ts:2333`, `:2451`, `:3903`, `:3921` — `pagelen: pagelen ?? legacyLimit`.
Плюс `normalizePagelen` (`src/pagination.ts:176-185`) режет по 100.

Итог: `limit: 500` возвращает 100 элементов и никак об этом не сообщает. Отсюда исторические
issue #37 («listRepositories returns only 10») и открытый #71 («getPullRequestComments only
returns max 10»). Формально они «починены» появлением `all`, но семантика `limit` осталась
контринтуитивной — LLM-клиент естественным образом читает `limit` как «верни столько».

**Правка:** трактовать `limit`/новый `maxItems` как общий кап с авто-пагинацией:
`pagelen = min(limit, 100)`, `all = limit > 100`, `maxItems = limit`.

### 2.5 Кап 1000 не настраивается ни из одного инструмента

`maxItems` в `PaginationRequestOptions` есть, но ни один вызов `fetchValues` его не передаёт —
жёстко 1000 везде. Для больших воркспейсов/длинных PR это потолок, который нельзя поднять,
а для дешёвых запросов — нельзя опустить.

### 2.6 `getPendingReviewPRs` вообще не пагинируется по репозиториям

`src/index.ts:3757-3767` — один сырой `api.get` на репозиторий, `pagelen: Math.min(limit, 50)`,
ни `all`, ни `sort`, ни следования `next`. В репозитории с >50 открытыми PR запросы на ревью
теряются. Ошибка по конкретному репо глушится `catch` (`:3815-3818`) и возвращает `[]` —
неотличимо от «нечего ревьюить».

### 2.7 Нет ретраев на 429

`grep -n "429\|retry\|backoff\|interceptors" src/index.ts` → ни одного совпадения.
При `all: true` это до 10 последовательных запросов подряд; один 429 роняет весь вызов
и уже собранные страницы выбрасываются.
**Правка:** axios-интерсептор с экспоненциальным бэкоффом по `Retry-After`.

---

## 3. Смежные баги, найденные попутно

**3.1 `getPendingReviewPRs` подставляет `name` вместо `slug`** — `src/index.ts:3738`:

```ts
repositoriesToCheck = reposResponse.values.map((repo: any) => repo.name);
```

Дальше значение уходит в URL как `repoSlug` (`:3758`). Для `managegocom/ai-chat` API отдаёт
`name: "AI-Chat"` при `full_name: "managegocom/ai-chat"` — это видно прямо в ответе, который
я получил выше. Репозитории с пробелами/точками/регистром в имени дают 404, который глушится
тем же `catch`. Нужен `repo.slug` (или хвост `full_name`).

**3.2 Инъекция кавычки в `listRepositories`** — `src/index.ts:2327`:
`params.q = \`name~"${name}"\`` — имя с `"` ломает запрос (400). Нужно экранирование.

**3.3 Bitbucket Server/DC не поддержан пагинатором** — `BitbucketPaginator` знает только
Cloud-модель (`page`/`pagelen`/`next`). У Server совсем другая (`start`/`limit`/`isLastPage`/
`nextPageStart`), при этом README и описание пакета обещают Server. Открытый issue #34.

**3.4 Тесты** — `__tests__/pagination.test.ts` содержит 3 кейса (pagelen+page, обрезка pagelen,
следование `next`). Не покрыты: кап `maxItems`, `all` + `page`, состав метаданных, ошибка
на середине пагинации.

**3.5 README** (`:203-210`) документирует `pagelen`/`page`/`all`/`limit`, но не упоминает,
что ответ — голый массив без признака «есть ещё».

---

## 4. Предлагаемый план правок

| # | Правка | Файл | Отдача / стоимость |
| --- | --- | --- | --- |
| P0 | Уйти с `npx bitbucket-mcp@latest` на сборку main (или форк) | `~/.claude/scripts/mcp-bitbucket.sh` | сразу даёт `sort` для pipelines + 3 багфикса; 1 строка |
| P1 | Единый payload-враппер с `hasMore`/`truncated` в 9 инструментах | `index.ts` | убирает тихую обрезку — главный источник неверных выводов; ~40 строк |
| P2 | Вернуть `next` + `truncated` из `all`-режима | `pagination.ts:141` | закрывает дыру в P1; ~8 строк |
| P3 | `sort` (+`q`) в схемы list-инструментов; дефолт `-created_on` для pipelines | `index.ts` | делает «последние N» выполнимым; ~30 строк |
| P4 | `limit`/`maxItems` как общий кап с авто-пагинацией | `index.ts` + `pagination.ts` | закрывает #37/#71 по смыслу, а не по букве |
| P5 | `getPendingReviewPRs`: `slug` вместо `name`, sort-then-slice, пагинация по репо | `index.ts:3738,3757,3841` | инструмент сейчас молча врёт |
| P6 | Бэкофф на 429 | `index.ts` (axios instance) | устойчивость `all: true` |
| P7 | Тесты на кап/`all`+`page`/метаданные | `__tests__/` | фиксирует P1–P4 |

**Стратегия.** Апстрим малоактивен: 5.0.7 не опубликован с апреля, #130/#71/#34 висят
открытыми. Реалистично — форк `setronica-ondemand/bitbucket-mcp`, P0 сразу, P1–P3 первым
PR (они закрывают ~90% ежедневной боли), P4–P7 следом. Патчи P1–P5 стоит параллельно
отправить и в апстрим — они не конфликтуют с его архитектурой.

**Что стоит перепроверить перед реализацией:** поддержка `sort`/`q` у Bitbucket Cloud
задокументирована как общий query-фреймворк, но по факту доступна не на всех коллекциях
(например, у `/commits` сортировки нет). Перед выкаткой P3 прогнать по одному живому вызову
на каждый эндпойнт и заводить `sort` только там, где API его реально принимает.
