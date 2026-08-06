# Changelog

## [1.4.2](https://github.com/ochanuco/webull-trading/compare/v1.4.1...v1.4.2) (2026-08-06)


### Bug Fixes

* align MCP get_positions description with cash-account wording ([fa8dee0](https://github.com/ochanuco/webull-trading/commit/fa8dee0f9b1e91fb5f2df3f68a23097eff140a17))
* align MCP get_positions description with cash-account wording ([f666f87](https://github.com/ochanuco/webull-trading/commit/f666f8702b57b3e7819dcc69881dd1ad77e720a7))

## [1.4.1](https://github.com/ochanuco/webull-trading/compare/v1.4.0...v1.4.1) (2026-08-03)


### Bug Fixes

* exclude volatility gate from HALF entry relaxation ([a14fb90](https://github.com/ochanuco/webull-trading/commit/a14fb90aa9277902690d1cc0956a95b908fab362))
* exclude volatility gate from HALF entry relaxation ([3a4ee52](https://github.com/ochanuco/webull-trading/commit/3a4ee520da94942e34fb3d6081edf2c27c02ce29))
* fail-closed re-entry guard during lastExitPrice migration window ([7d66499](https://github.com/ochanuco/webull-trading/commit/7d66499728266e90691cd0a1ecac986497a95338))
* make market hours check market- and holiday-aware ([48affa5](https://github.com/ochanuco/webull-trading/commit/48affa5de606332dfae65ffb464270b1d80195ea))
* make market hours check market- and holiday-aware ([7a6ccde](https://github.com/ochanuco/webull-trading/commit/7a6ccdebd55f325ec8fbe6721ef9d2766babc13f))
* normalize exit cooldown to next session open ([f05f788](https://github.com/ochanuco/webull-trading/commit/f05f788dad5bc77555919d61f6b34a352641ad9e))
* normalize exit cooldown to next session open ([2c37996](https://github.com/ochanuco/webull-trading/commit/2c37996c857198d36458436965e3b5d864d81aa8))
* persist lastExitPrice explicitly instead of inferring from lastExecutedPrice ([3b17345](https://github.com/ochanuco/webull-trading/commit/3b17345ffb01653a10dc75502c9826425407920b))
* persist lastExitPrice explicitly instead of inferring from lastExecutedPrice ([30badc6](https://github.com/ochanuco/webull-trading/commit/30badc65dba55e1f969684894da7d8c6aef19ecc))
* point [#658](https://github.com/ochanuco/webull-trading/issues/658) regression fixtures at lastExitPrice after [#660](https://github.com/ochanuco/webull-trading/issues/660) merge ([71d3c91](https://github.com/ochanuco/webull-trading/commit/71d3c911b10b7c14594b048856e45dcc81a701b0))
* promote HALF entries only from strategy-declared entry-gate holds ([6a57d1e](https://github.com/ochanuco/webull-trading/commit/6a57d1ebde2c8f385736b4598681731e9a7fc327))
* promote HALF entries only from strategy-declared entry-gate holds ([84ca26a](https://github.com/ochanuco/webull-trading/commit/84ca26ac56e4d2ac7a7a64e25938d12ec74079d8))

## [1.4.0](https://github.com/ochanuco/webull-trading/compare/v1.3.1...v1.4.0) (2026-07-29)


### Features

* **strategy:** measure volatility against the symbol's own distribution ([125e5eb](https://github.com/ochanuco/webull-trading/commit/125e5eb1c8678f30ff659750e5b20dd7a2b7b182))
* **strategy:** measure volatility against the symbol's own distribution ([03b8915](https://github.com/ochanuco/webull-trading/commit/03b8915915d26423757ce192c61f519696c168df))

## [1.3.1](https://github.com/ochanuco/webull-trading/compare/v1.3.0...v1.3.1) (2026-07-28)


### Bug Fixes

* **dashboard:** hold the trade columns on one line up to realized PnL ([3e2a53e](https://github.com/ochanuco/webull-trading/commit/3e2a53eb0c38f4548d6bd1b3cef1419dd932f127))
* **dashboard:** hold the trade columns on one line up to realized PnL ([a5a9705](https://github.com/ochanuco/webull-trading/commit/a5a9705f72a9730b8d6b5d801ad12c0c2df91b36))

## [1.3.0](https://github.com/ochanuco/webull-trading/compare/v1.2.0...v1.3.0) (2026-07-28)


### Features

* **dashboard:** build the home the mock promised ([9a31b90](https://github.com/ochanuco/webull-trading/commit/9a31b90752015d8e2bb3fe1f0d90a1862f723bb1))
* **dashboard:** build the home the mock promised ([7695315](https://github.com/ochanuco/webull-trading/commit/76953155f36200f128719e0484cbe2a88ce6b57c))


### Bug Fixes

* **dashboard:** cap the width on every page, not just the home ([4924fbb](https://github.com/ochanuco/webull-trading/commit/4924fbb943ee31158c5d47d65574ba7953bb3a04))
* **dashboard:** cap the width on every page, not just the home ([1e354c8](https://github.com/ochanuco/webull-trading/commit/1e354c815e23abc4fcb848a5f4f726c49262271c))
* **dashboard:** confine the width ceiling to the home page ([32c53dc](https://github.com/ochanuco/webull-trading/commit/32c53dc6ff0b9bb7a3661818c7172425043d987a))
* **dashboard:** confine the width ceiling to the home page ([28f7784](https://github.com/ochanuco/webull-trading/commit/28f77842387df7140835fdf759dd1a347ad25a64))
* **dashboard:** keep limit prices on one line in the trade history ([01e75a0](https://github.com/ochanuco/webull-trading/commit/01e75a033d940c33e978875b3290021d0fd454e3))
* **dashboard:** keep limit prices on one line in the trade history ([60ae3d9](https://github.com/ochanuco/webull-trading/commit/60ae3d9003b5eeff78fc74dc8095150161f0e5b1))
* **dashboard:** let the name column absorb the slack, not the clock ([663accc](https://github.com/ochanuco/webull-trading/commit/663accc6627a9b73281278c6acad3387af57d18e))
* **dashboard:** let the name column absorb the slack, not the clock ([e5d4a3f](https://github.com/ochanuco/webull-trading/commit/e5d4a3f342c0a5fdaa398c745b076199f70c3c44))


### Refactors

* **dashboard:** drop the decision matrix ([d97fc65](https://github.com/ochanuco/webull-trading/commit/d97fc650e57da1c736fcf400014e28e1cbdf5782))
* **dashboard:** drop the decision matrix ([93fff69](https://github.com/ochanuco/webull-trading/commit/93fff69eceec998336f6040e35c5e9e3f7ebc6c2))
* **dashboard:** retire the standalone position and account pages ([0687088](https://github.com/ochanuco/webull-trading/commit/0687088c184e2b469a787498c8986698082decd7))
* **dashboard:** retire the standalone position and account pages ([5ba7962](https://github.com/ochanuco/webull-trading/commit/5ba7962e093a33dbec706ca4c87a59ab14cb10cb))

## [1.2.0](https://github.com/ochanuco/webull-trading/compare/v1.1.1...v1.2.0) (2026-07-28)


### Features

* **dashboard:** demote diagnostics out of the daily navigation ([a5abd0a](https://github.com/ochanuco/webull-trading/commit/a5abd0a4e17b15d4f60cc050b6a47f8dc6971a64))
* **dashboard:** demote diagnostics out of the daily navigation ([8dff7b6](https://github.com/ochanuco/webull-trading/commit/8dff7b6fd5702cc9e327ab8d083bcf0cfb446d61))
* **dashboard:** fold the home into run state, risk and activity ([dc02f47](https://github.com/ochanuco/webull-trading/commit/dc02f477f8886b434b0c3f7c1046c7c4ecc86f2d))
* **dashboard:** fold the home into run state, risk and activity ([d41ae7f](https://github.com/ochanuco/webull-trading/commit/d41ae7f70643eb981fff8b3c146455883ac64e23))
* **dashboard:** name the review tabs after what they show ([c763369](https://github.com/ochanuco/webull-trading/commit/c763369ae72337ffffbb1a9f4c70dd474a7340a7))
* **dashboard:** name the review tabs after what they show ([3303c1b](https://github.com/ochanuco/webull-trading/commit/3303c1bcf40978faa21d4212cc0d41ff7a99371b))

## [1.1.1](https://github.com/ochanuco/webull-trading/compare/v1.1.0...v1.1.1) (2026-07-28)


### Bug Fixes

* **news:** give GDELT a timeout it can actually meet ([b5a8494](https://github.com/ochanuco/webull-trading/commit/b5a8494aba8528611b5d93c133218cd690c52899))
* **news:** give GDELT a timeout it can actually meet ([1b317a7](https://github.com/ochanuco/webull-trading/commit/1b317a79e6803db6f08c2779a19db306bad73604))

## [1.1.0](https://github.com/ochanuco/webull-trading/compare/v1.0.2...v1.1.0) (2026-07-28)


### Features

* **news:** add attention observation store and GDELT producer ([db07ed3](https://github.com/ochanuco/webull-trading/commit/db07ed3a964e077e23ff10a655f9b135a3fd0ad8))
* **news:** add attention observation store and GDELT producer ([da14fc8](https://github.com/ochanuco/webull-trading/commit/da14fc8cea16b78f78e26ea896949a548d2a8c7a))
* **news:** turn on the GDELT observation producer ([7d52fe2](https://github.com/ochanuco/webull-trading/commit/7d52fe299aac83e82b15222ca6480c7b106a4b48))
* **news:** turn on the GDELT observation producer ([70903e9](https://github.com/ochanuco/webull-trading/commit/70903e91b554e5cdcb43261a4e9ba0f8bf0759e9))
* **risk:** add news shock gate behind an off-by-default toggle ([d93222e](https://github.com/ochanuco/webull-trading/commit/d93222e575685ee6c2b68970969b52fa66476a6a))
* **risk:** add news shock gate behind an off-by-default toggle ([3d7ecb7](https://github.com/ochanuco/webull-trading/commit/3d7ecb77c98b280a860cc26d27ab568456007536))


### Bug Fixes

* **ci:** retitle the promotion PR when a newer release supersedes it ([#614](https://github.com/ochanuco/webull-trading/issues/614)) ([7c0ac81](https://github.com/ochanuco/webull-trading/commit/7c0ac815ad6aa8915f7272c4bfea40eb6cdd42a6))
* **db:** keep bulk inserts within the D1 bound parameter limit ([9a7a665](https://github.com/ochanuco/webull-trading/commit/9a7a665307f9437c39c0ecdfbee1f764533bc41e))
* **risk:** stop a bad news gate config from halting the strategy cron ([965be50](https://github.com/ochanuco/webull-trading/commit/965be50229d4f0938456b192e4c07a7cb5aa7f99))

## [1.0.2](https://github.com/ochanuco/webull-trading/compare/v1.0.1...v1.0.2) (2026-07-27)


### Bug Fixes

* **ci:** let the release PR carry its component so tagging is automatic ([#612](https://github.com/ochanuco/webull-trading/issues/612)) ([2fe6b9c](https://github.com/ochanuco/webull-trading/commit/2fe6b9c87f2b59e051193e91d8d6624052cf8fac))
* **ci:** stop release-please skipping its own merged release PR ([#610](https://github.com/ochanuco/webull-trading/issues/610)) ([f0ca6e1](https://github.com/ochanuco/webull-trading/commit/f0ca6e14a466c8cd4a4a227f95757db3adda5f8c))

## [1.0.1](https://github.com/ochanuco/webull-trading/compare/v1.0.0...v1.0.1) (2026-07-27)


### Bug Fixes

* **ci:** keep every placeholder in the release PR title pattern ([#607](https://github.com/ochanuco/webull-trading/issues/607)) ([96517a4](https://github.com/ochanuco/webull-trading/commit/96517a46172dae2822cc84cc7a35f07f1bbb5006))
* **ci:** make dependency updates produce a release ([#604](https://github.com/ochanuco/webull-trading/issues/604)) ([5d79ae8](https://github.com/ochanuco/webull-trading/commit/5d79ae8e4dc0ec592324670c6fc67be65500626f))
* **ci:** put the version in the release PR title ([#606](https://github.com/ochanuco/webull-trading/issues/606)) ([60d7f3a](https://github.com/ochanuco/webull-trading/commit/60d7f3ab2ea377ea63d0d3de81b6d7aaf4b03248))
* **ci:** title the grouped release PR with the version ([#609](https://github.com/ochanuco/webull-trading/issues/609)) ([407643a](https://github.com/ochanuco/webull-trading/commit/407643a47fb65e86596209327887c5f065a44f55))
