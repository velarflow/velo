# VelarFlow — ocena całości (po Pakiet 7)

> Stan na 2026-05-28, po wdrożeniu PAKIET 7 (nawigacja: liczniki, zwijanie grup, rozwijane Ustawienia).
> App.jsx: 9312 linii. ESLint baseline: 80 errors. Build: ~225ms, 499KB JS.

---

## Co jest dobre (i to nie są komplementy z grzeczności)

**1. Dyscyplina inkrementalna.**
Workflow "Pakiet 1 → 9 + 5 + 6 + 7" z jednym checkpoint commit per pakiet i wymaganiem `0 nowych błędów ESLint` jest rzadko widziany. Większość projektów na tym etapie ma bałagan branchy — ty masz czystą, linearną historię i każdy commit jest weryfikowalny. To rzecz, którą widać u zespołów z 5 lat doświadczenia, nie u solo dev w dogfooding fazie.

**2. Storage layer jest *przemyślany*.**
`Storage._ns = "velarflow:"`, quota handling z emergency cleanup, secure obfuscation z dokumentacją "to nie szyfrowanie", `_maxKB` z limitem w *bajtach* (nie length stringa) — to nie są rzeczy, które wpadną komuś na 4. dzień projektu. Ktoś już raz na localStorage się przejechał i wyciągnął wnioski.

**3. Architektura ról + uprawnień solidna.**
`ROLES`, `PERMISSIONS`, `can()`, plus separowane `MaintenanceView` / `CleaningTeamView` / `WorkerView` / Manager — to nie jest po prostu `if (user.isAdmin)` rozsiane po pliku. To realny system, który skaluje się na nowe role bez refaktora.

**4. Form Builder (Pakiet 4-5) to ambicja powyżej średniej.**
Konfigurowalny `FormSchema` per kategoria, deep-link do zakładek settings (Pakiet 7.5), wyposażenie z roomami (Pakiet 6) — to są decyzje produktowe „nie zmuszaj usera do gotowych pól, daj mu budować swoje". W praktyce większość property mgmt apps tego nie ma.

**5. Dogfooding wymusza realizm.**
Widać że pakiety nie są podzielone akademicko ("najpierw architektura, potem features"), tylko po faktycznym bólu użytkownika ("rozwijane Ustawienia bo nie mogę szybko skoczyć do zakładki"). To zdrowy znak.

---

## Co bolą i będzie bolało coraz bardziej

**1. Single-file 9312 linii to ściana, która rośnie liniowo.**
Świadoma decyzja — rozumiem, dogfooding faza, łatwiej trzymać kontekst w głowie. Ale już teraz:
- `App` komponent ma ~1500+ linii (od ~7800 do końca)
- Hooki muszą być przed early returnami → przy każdym nowym `useMemo`/`useState` musisz to pamiętać (jak w Pakiet 7 musiałem przenosić counters)
- ESLint linting trwa 5-10 sekund (vs <1s gdyby był podzielony)
- Każdy edit ryzykuje konflikt z innym pakietem, jeśli kiedykolwiek będzie więcej niż 1 osoba

**Próg bólu nadejdzie ~12-15k linii.** Nie teraz, ale niedługo. Sugestia: po Pakiet 8 wydzielić chociaż `Storage`/`Audit`/`Settings`/`FormSchema` (linie 188-2090, ~1900 linii czystych "model" warstw) do `src/lib/`. Nie ma żadnego ryzyka, są to czyste obiekty bez React.

**2. Dwa configi ESLint to bałagan, który *kłamie* o jakości kodu.**
`eslint.config.js` (568B, scaffold Vite) wygrywa nad `.mjs` (2987B, ten faktycznie napisany), więc:
- Brakuje `eslint-plugin-react` → ~40 komponentów oznaczone jako "unused" bo plugin nie wie że JSX ich używa
- Brak `__VELARFLOW_DEMO__` globala
- "Baseline 80 errors" to w 90% efekt tego bugu, nie kodu

Realny stan kodu jest prawdopodobnie ~8-12 prawdziwych warningów. **Usunąć `eslint.config.js`** to 5 sekund pracy, która zmniejszy "noise" o 70 errors i odsłoni prawdziwe problemy.

**3. Niektóre prawdziwe problemy są ukryte przez ten noise:**
- `OwnerForm` (linia ~4070) czyta `allFields.current` podczas renderu — to ma realny potencjał race condition przy rerendach
- "Calling setState synchronously within an effect" (linia 2502) — jest jedno faktyczne miejsce z cascading renders
- `'updateTaskStatus' never used` (linia 8425) — pewnie dead code z któregoś refaktora

Tych jest może ~8-10 i są legitne. Ale toną w 70 false-positivach.

**4. CSS-in-template-string skaluje się źle.**
~3000 linii CSS w jednym JS template literal (linie ~2440-2950 z drobnymi rozszerzeniami w pakietach). Już teraz:
- Brak autocomplete w edytorze
- Brak linting dla CSS
- Łatwo zrobić duplikat klasy (sam dodałem `.nav-badge` w Pakiet 7 bez sprawdzenia czy nie ma podobnej `.badge` w linii 2987)
- Hot reload działa wolniej

To było OK na 1000 linii. Na 3000 to już dług. Nie kryzys, ale dług.

**5. Komentarze typu `// FIX #42`, `// FIX 3.A`, `// FIX 7.6` to historia w kodzie.**
Tych jest kilkadziesiąt. Każdy wymaga od czytelnika znajomości kontekstu pakietu/incydentu. Po roku nikt — łącznie z tobą — nie będzie pamiętać co było FIX #42. To info należy do `git log` i commit messages (które masz świetne), nie do kodu. Sugestia: przy najbliższej okazji do refactoru — przy każdym dotykanym pliku usuwać te komentarze, *chyba że* opisują nieoczywiste constraint (np. "limit w bajtach nie length stringa #17" — TO zostaw, bo to ostrzeżenie dla przyszłego edytora).

**6. Zero testów.**
Wiem, dogfooding, manual testing. Ale `Storage`, `FormSchema`, `RateLimiter`, `SessionStore`, `can()` — to czyste funkcje/obiekty bez React, idealnie testowalne. 50-100 linii vitest dałoby ci sieć bezpieczeństwa przy refaktorze (a refaktor *przyjdzie*).

**7. Brak TypeScript.**
Devdependencies *mają* `@types/react`, więc setup jest pół-gotowy. W kontekście `FormSchema` (schemat o dynamicznej strukturze), `Settings.getAll()` (zwraca obiekt o nieznanym shape), `ROLES`/`PERMISSIONS` — TypeScript wyłapałby prawdziwe bugi, których ESLint nie złapie. Migracja `.jsx → .tsx` z `// @ts-check` na początek jest tania.

---

## Architektoniczna obserwacja

Aplikacja jest **modularna logicznie, monolityczna fizycznie**. Masz `Storage`, `Categories`, `Loans`, `Files`, `FormSchema`, `EquipmentRooms`, `Settings`, `CleaningSessions`, `Audit`, `RateLimiter`, `SessionStore` jako *osobne obiekty z czystym API* — to są de facto moduły. Tylko że siedzą w jednym pliku. To jest właściwie *gotowe do podziału* — każdy z nich można wyciąć z minimalną pracą.

Najbardziej oporne do podziału byłyby views (`SettingsView` 900 linii, `LoansView`, `FilesView`) bo mają dużo lokalnego state i closures z App. Ale `Storage`, `Audit`, `Categories`, `FormSchema` itp. wyrwałbyś w 30 minut bez ryzyka.

---

## Twoja relacja z kodem (subiektywne)

Widać, że:
- **Zależy ci na jakości UX, nie tylko na "działa"** (przemyślane: `ScrollableTabs`, sticky headers, master-detail split ≥1280px, dark mode, role-aware UI, offline queue)
- **Akceptujesz dług świadomie** (single-file = wiadomy wybór, nie zaniedbanie)
- **Mam wrażenie, że mocno się angażujesz w detale** (np. animacja edge tabs w ScrollableTabs, FIX historii dla każdej drobnostki) — to skądinąd doskonała cecha, ale na 9k linii jednego pliku zaczyna być sport ekstremalny. Zwracam uwagę bo *jeśli* któraś sesja nagle ci się rozjeżdża i nie wiesz czemu — to *prawdopodobnie* dlatego, że kontekst nie mieści ci się w głowie, mimo że nadal myślisz że się mieści.

---

## Ranking bólu (gdzie najpierw bym uderzył)

1. **Usunąć `eslint.config.js`** — 5 minut, 70 false-positive errors znika, prawdziwe wychodzą na powierzchnię
2. **Naprawić tych 8-10 prawdziwych ESLint issues** — kilka godzin, kod jest realnie czystszy
3. **Wyciąć `src/lib/storage.js`, `src/lib/categories.js`, `src/lib/form-schema.js` z App** — pół dnia, App spada do 7k linii, zero ryzyka
4. **Dodać vitest + 30-50 testów na `Storage`/`FormSchema`/`can()`** — 1 dzień, sieć bezpieczeństwa pod refaktor
5. **Migracja na TypeScript z `allowJs: true`** — można robić plik po pliku, miesiącami

Pierwsze 3 to "rzeczy oczywiste, zrób natychmiast". Pozostałe 2 to "po Pakiecie 8, jak skończysz feature push".

---

## Werdykt

Aplikacja jest na poziomie **"poważny dogfooded MVP na granicy production-readiness"**. To znacznie powyżej średniej dla side-projects, ale **dług techniczny zaczyna być widoczny w każdym pakiecie** (nie tylko jako "trzeba kiedyś" — jako *spowolnienie tu i teraz*). Im dłużej zwlekasz z podziałem pliku i naprawą ESLint, tym bardziej każdy następny pakiet będzie cię kosztował.

Człowiek by powiedział: **świetnie się to czyta, ale czuję jak rośnie napięcie pod skórą.**
