# F1-D — Smoke real do systemd no Arch

**Fonte:** atestado do operador / Tech Lead em 2026-11-08, no brief "F1: aceite técnico e preparação do merge". O JSON do comando **não consta neste workspace**: os resultados abaixo são **atestado manual**, não prova automatizada nesta VM. O formato segue `docs/evidence/e4-arch.md`.

**Comando:** `./scripts/cockpit f1-systemd-smoke` (`src/f1-systemd-smoke.ts`), com `COCKPIT_F1_SMOKE_CONFIRMED=yes`.
**VM usada:** `codex-cockpit-e0-test` (VM de teste, não a de uso diário).
**Commit testado:** `842cecf` (`feat/f1-daily-ops`, HEAD na data).
**Resultado geral: `NOT_VERIFIED`, exit 2.** Isso é o resultado honesto do próprio smoke, não uma falha: um item não pôde ser exercitado (ver abaixo).

## Resultado atestado, por verificação

| Verificação | Resultado atestado | O que comprova |
| --- | --- | --- |
| `unit_loaded` | **PASS** | O systemd do usuário carregou a unit de runtime gerada do template real do serviço |
| `no_new_privileges` | **PASS** (`NoNewPrivs: 1`) | O processo principal roda com `NoNewPrivileges=yes` |
| `credential_file` | **PASS** | Login com a credencial lida do arquivo 0600, sem variável de ambiente |
| `msb_list` | **PASS** | Discovery (`msb list`) funciona sob o systemd e `NoNewPrivileges=yes` |
| `msb_exec` | **PASS** | `msb exec` real (Codex `initialize` + `thread/list`, só leitura, sem prompt e sem quota) funciona sob o systemd e `NoNewPrivileges=yes`. **Era a condição aberta da revisão F1-D** |
| `crash_restart` | **PASS** | SIGKILL do processo principal → o systemd reinicia o serviço |
| `msb_exec_after_restart` | **PASS** | `msb exec` volta a funcionar depois do reinício |
| `orderly_stop` | **PASS** | Parada ordenada, saída 0, filhos do próprio Cockpit encerrados |
| `refused_start_not_restarted` | **PASS** | Início recusado sai com 78 e não é reiniciado automaticamente |
| `journal_clean` | **PASS** | A credencial não aparece no journal |
| `cleanup` | **PASS** | Unit, arquivos e cgroup removidos |
| **`orphan_ledger`** | **NOT_VERIFIED** | **Nenhum filho `msb` sobreviveu à queda** (SIGKILL do Cockpit encerrou o `msb exec` junto), então o registro de órfãos não pôde ser exercitado sob o systemd |

Por construção do smoke (`src/f1-systemd-smoke.ts`), um `orphan_ledger` sem sobreviventes resulta em `NOT_VERIFIED` e impede o `overall: PASS`. O smoke **não foi alterado** para fabricar PASS, e **`NoNewPrivileges=yes` foi mantido**: o `msb exec` funcionou com ele ativo, então não há evidência nem justificativa para removê-lo.

O atestado não informa os contadores de cada verificação além do status. Este registro não os reproduz.

## O que este resultado comprova e o que não comprova

**Comprovado (atestado):**
- o serviço, nos moldes da unit gerada, opera o Microsandbox no Arch (`msb list` e `msb exec`) com `NoNewPrivileges=yes`, antes e depois de um reinício;
- queda → reinício, parada ordenada, recusa de início sem laço de reinício e journal sem credencial, sob o systemd real;
- limpeza completa.

**NÃO comprovado:**
- **a recuperação de órfãos reais sob o systemd**: o caminho "um filho `msb` sobrevive à queda → aparece no ledger → bloqueia envios → `kill <pid>` libera" nunca foi observado no Arch com um órfão real. O que existe é o drill E4 (11/11), com processos simulados (`docs/evidence/e4-arch.md`), e os testes automatizados;
- o dia de uso real (aceite §8 do master plan), as etapas B e C do `docs/f1-operacao-diaria.md` §6, e qualquer comportamento com a VM de uso diário.

## Aceitação excepcional do risco residual (Tech Lead)

O Tech Lead aceitou **excepcionalmente** este resultado `NOT_VERIFIED` como evidência suficiente para **integrar** a F1 ao `develop`, considerando que o mecanismo de recuperação de órfãos também passou no drill E4 (11/11). Termos da aceitação:

1. A aceitação **não significa** que a recuperação de órfãos reais foi comprovada. O risco fica **registrado como aberto**.
2. O smoke não deve ser alterado para obter PASS.
3. `NoNewPrivileges=yes` não deve ser removido sem evidência e justificativa.
4. A aceitação vale para a integração. **Não dispensa** o aceite de um dia de uso real no Arch.

## Pendência aberta: recuperação de órfãos reais

**ID:** `F1-P1` · **Responsável:** operador (Arch), com apoio do executor · **Prazo:** antes de declarar a V1 (§8.3 do master plan: "queda com Claude real e com Codex real: órfãos visíveis e bloqueando") e, no mais tardar, junto com a F2.

**Critério de aceite** (teste controlado, quota mínima, em VM de teste):
1. Com o serviço sob o systemd (unit de runtime isolada, como no smoke, ou o serviço instalado, por decisão do operador), iniciar **um turno longo** em uma VM de teste, para que exista um `msb exec` em trabalho.
2. SIGKILL do processo principal (`systemctl --user kill --kill-whom=main --signal=SIGKILL`). O `KillMode=process` deve **deixar** o filho `msb` vivo.
3. Após o reinício, confirmar que o filho aparece em "Precisa de você" como **Processo órfão**, com o PID, e que um novo envio para a sessão ou VM é recusado com `409 orphan_process_alive`.
4. Conferir o resultado na VM e, só então, `kill <pid>` no host. O bloqueio some sozinho e o run em voo fica **Não confirmado**, sem reenvio.
5. Registrar em `docs/evidence/` o resultado, separando o executado do atestado.

**Por que o smoke não o cobriu:** o `msb exec` do smoke serve só leituras curtas (`thread/list`) e termina junto com o Cockpit. Só um turno em andamento mantém um filho vivo. Isso exige um prompt real (quota mínima, 1–2 prompts), que o smoke deliberadamente não faz. Este teste coincide com o drill manual da **F2** do master plan §7, e pode ser feito junto com ele. O master plan não foi alterado: esta pendência vive aqui e em `docs/f1-operacao-diaria.md`.
