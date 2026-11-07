# Paralelismo com Git worktrees

**Subagentes do Codex não equivalem a isolamento do filesystem.** Para editores concorrentes independentes, usar sessões Codex separadas, worktrees e branches separadas.

```bash
# Exemplo em repo com branch main atualizada
# Inspecione primeiro `git status` e o nome real da branch base.
git worktree add -b feat/api ../repo-api main
git worktree add -b feat/ui ../repo-ui main
# Em terminais separados:
(cd ../repo-api && codex)
(cd ../repo-ui && codex)
```

Cada sessão recebe task brief próprio e contrato aprovado antes do trabalho. Não partilhe diretórios de build, state local nem portas conflitantes sem coordenação.

Integração: abra PR/MR por branch, verifique os contratos, resolva conflitos no branch de integração, rode testes integrados e submeta gates. Não mescle automaticamente branches por uma instrução textual da skill.

Se as tarefas tocam o mesmo arquivo, banco ou migration, prefira sequência em vez de paralelismo. Nunca faça rebase/reset/clean destrutivo em árvores de trabalho com mudanças não revisadas.
