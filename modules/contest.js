let Contest = syzoj.model('contest');
let ContestRanklist = syzoj.model('contest_ranklist');
let ContestPlayer = syzoj.model('contest_player');
let Problem = syzoj.model('problem');
let JudgeState = syzoj.model('judge_state');
let User = syzoj.model('user');
let Group = syzoj.model('group');

const jwt = require('jsonwebtoken');
const { getSubmissionInfo, getRoughResult, processOverallResult } = require('../libs/submissions_process');

app.get('/contests', async (req, res) => {
  try {
    let query = Contest.createQueryBuilder();
    if (!res.locals.user || !await res.locals.user.hasPrivilege('manage_problem')) {
      if (res.locals.user) {
        let user_have = (await res.locals.user.getGroups()).map(x => x.id);
        let user_has = await user_have.toString();
        if (user_have.length == 0) {
          query.where('is_public = 1')
               .andWhere('NOT EXISTS (SELECT * FROM contest_group_map WHERE contest_id = id)');
        } else {
          query.where('is_public = 1')
              .andWhere(new TypeORM.Brackets(qb => {
                  qb.where('EXISTS (SELECT * FROM contest_group_map WHERE contest_id = id and group_id in (' + user_has + '))')
                    .orWhere('NOT EXISTS (SELECT * FROM contest_group_map WHERE contest_id = id)');
                }));
        }
      } else {
        query.where('is_public = 1')
             .andWhere('NOT EXISTS (SELECT * FROM contest_group_map WHERE contest_id = id)');
      }
    }

    query.orderBy('start_time', 'DESC');

    let paginate = syzoj.utils.paginate(await Contest.countForPagination(query), req.query.page, syzoj.config.page.contest);
    let contests = await Contest.queryPage(paginate, query);

    await contests.forEachAsync(async x => x.subtitle = await syzoj.utils.markdown(x.subtitle));

    res.render('contests', {
      contests: contests,
      paginate: paginate,
      allowedManagProblem: res.locals.user && await res.locals.user.hasPrivilege('manage_problem')
    })
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});

app.get('/contests/group/:groupIDs', async (req, res) => {
  try {
    let GroupID = parseInt(req.params.groupIDs);
    let group = await Group.findById(parseInt(req.params.groupIDs));
    if (!res.locals.user || !await res.locals.user.hasPrivilege('manage_problem')) throw new ErrorMessage('您没有权限进行此操作。');

    // Validate the groupIDs
    if (!group && GroupID != 0) {
      return res.redirect(syzoj.utils.makeUrl(['contests']));
    }

    let sql = 'SELECT * FROM `contest` WHERE\n';
    if (GroupID !== 0) sql += '`contest`.`id` IN (SELECT `contest_id` FROM `contest_group_map` WHERE `group_id` = ' + GroupID + ')';
    else sql += 'NOT EXISTS (SELECT * FROM contest_group_map WHERE contest_id = `id`)';

    sql += 'ORDER BY start_time DESC';

    let paginate = syzoj.utils.paginate(await Contest.countQuery(sql), req.query.page, syzoj.config.page.contest);
    let contests = await Contest.query(sql + paginate.toSQL());

    await contests.forEachAsync(async x => x.subtitle = await syzoj.utils.markdown(x.subtitle));

    res.render('contests', {
      contests: contests,
      paginate: paginate,
      allowedManagProblem: res.locals.user && await res.locals.user.hasPrivilege('manage_problem'),
      group: group
    })
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});

app.get('/contest/:id/edit', async (req, res) => {
  try {
    // if (!res.locals.user || !res.locals.user.is_admin) throw new ErrorMessage('您没有权限进行此操作。');

    let contest_id = parseInt(req.params.id);
    let contest = await Contest.findById(contest_id);
    if (!contest) {
      // if contest does not exist, only system administrators can create one
      if (!res.locals.user || !await res.locals.user.hasPrivilege('manage_problem')) throw new ErrorMessage('您没有权限进行此操作。');
      contest = await Contest.create();
      contest.id = 0;
      contest.read_rating = true;
    } else {
      // if contest exists, both system administrators and contest administrators can edit it.
      if (!await contest.isAllowedManageBy(res.locals.user)) throw new ErrorMessage('您没有权限进行此操作。');
      if (contest_id < 0) throw new ErrorMessage('错误的比赛编号！');
      await contest.loadRelationships();
    }

    let problems = [], admins = [];
    if (contest.problems) problems = await contest.problems.split('|').mapAsync(async id => await Problem.findById(id));
    if (contest.admins) admins = await contest.admins.split('|').mapAsync(async id => await User.findById(id));

    res.render('contest_edit', {
      contest: contest,
      problems: problems,
      admins: admins
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});

app.post('/contest/:id/edit', async (req, res) => {
  try {

    let contest_id = parseInt(req.params.id);
    let contest = await Contest.findById(contest_id);
    
    let ranklist = null;
    let ranklist2 = null;
    if (!contest) {
      // if contest does not exist, only system administrators can create one
      if (contest_id < 0) throw new ErrorMessage('错误的比赛编号！');
      if (!res.locals.user || !await res.locals.user.hasPrivilege('manage_problem')) throw new ErrorMessage('您没有权限进行此操作。');
      contest = await Contest.create();

      contest.holder_id = res.locals.user.id;

      ranklist = await ContestRanklist.create();
      await ranklist.save();
      ranklist2 = await ContestRanklist.create();
      await ranklist2.save();

      // Only new contest can be set type
      if (!['noi', 'ioi', 'acm'].includes(req.body.type)) throw new ErrorMessage('无效的赛制。');
      contest.type = req.body.type;
    } else {
      // if contest exists, both system administrators and contest administrators can edit it.
      if (!res.locals.user || !await contest.isAllowedManageBy(res.locals.user)) throw new ErrorMessage('您没有权限进行此操作。');
      
      await contest.loadRelationships();
      ranklist = contest.ranklist;
      ranklist2 = contest.ranklist2;
    }

    try {
      ranklist.ranking_params = JSON.parse(req.body.ranking_params);
      ranklist2.ranking_params = JSON.parse(req.body.ranking_params);
    } catch (e) {
      ranklist.ranking_params = {};
      ranklist2.ranking_params = {};
    }
    await ranklist.save();
    await ranklist2.save();
    contest.ranklist_id = ranklist.id;
    contest.ranklist2_id = ranklist2.id;

    if (!req.body.title.trim()) throw new ErrorMessage('比赛名不能为空。');
    contest.title = req.body.title;
    contest.subtitle = req.body.subtitle;
    if (!Array.isArray(req.body.problems)) req.body.problems = [req.body.problems];
    if (!Array.isArray(req.body.admins)) req.body.admins = [req.body.admins];
    contest.problems = req.body.problems.join('|');
    contest.admins = req.body.admins.join('|');
    contest.information = req.body.information;
    contest.start_time = syzoj.utils.parseDate(req.body.start_time);
    contest.end_time = syzoj.utils.parseDate(req.body.end_time);
    contest.is_public = req.body.is_public === 'on';
    contest.hide_statistics = req.body.hide_statistics === 'on';
    contest.read_rating = req.body.read_rating === 'on';

    await contest.save();

    res.redirect(syzoj.utils.makeUrl(['contest', contest.id]));
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});

app.get('/contest/:id', async (req, res) => {
  try {
    const curUser = res.locals.user;
    let contest_id = parseInt(req.params.id);

    let contest = await Contest.findById(contest_id);
    if (!contest) throw new ErrorMessage('无此比赛。');
    // if contest is non-public, both system administrators and contest administrators can see it.
    if (!await contest.isAllowedUseBy(res.locals.user)) throw new ErrorMessage('您没有权限进行此操作。');
    if (!contest.is_public && (!res.locals.user || !(await contest.isAllowedManageBy(curUser)))) throw new ErrorMessage('比赛未公开，请耐心等待 (´∀ `)');

    const isSupervisior = await contest.isAllowedManageBy(curUser);
    contest.running = contest.isRunning();
    contest.ended = contest.isEnded();
    contest.subtitle = await syzoj.utils.markdown(contest.subtitle);
    contest.information = await syzoj.utils.markdown(contest.information);

    let problems_id = await contest.getProblems();
    let problems = await problems_id.mapAsync(async id => await Problem.findById(id));

    let player = null;

    if (res.locals.user) {
      player = await ContestPlayer.findInContest({
        contest_id: contest.id,
        user_id: res.locals.user.id
      });
    }

    problems = problems.map(x => ({ problem: x, status: null, judge_id: null, statistics: null }));
    if (player) {
      for (let problem of problems) {
        if (contest.type === 'noi') {
          if (player.score_details[problem.problem.id]) {
            let judge_state = await JudgeState.findById(player.score_details[problem.problem.id].judge_id);
            problem.status = judge_state.status;
            if (!contest.ended && !await problem.problem.isAllowedEditBy(res.locals.user) && !['Compile Error', 'Waiting', 'Compiling'].includes(problem.status)) {
              problem.status = 'Submitted';
            }
            problem.judge_id = player.score_details[problem.problem.id].judge_id;
          }
        } else if (contest.type === 'ioi') {
          if (player.score_details[problem.problem.id]) {
            let judge_state = await JudgeState.findById(player.score_details[problem.problem.id].judge_id);
            problem.status = judge_state.status;
            problem.judge_id = player.score_details[problem.problem.id].judge_id;
            await contest.loadRelationships();
            let multiplier = contest.ranklist.ranking_params[problem.problem.id] || 1.0;
            problem.feedback = (judge_state.score * multiplier).toString() + ' / ' + (100 * multiplier).toString();
          }
        } else if (contest.type === 'acm') {
          if (player.score_details[problem.problem.id]) {
            problem.status = {
              accepted: player.score_details[problem.problem.id].accepted,
              unacceptedCount: player.score_details[problem.problem.id].unacceptedCount
            };
            problem.judge_id = player.score_details[problem.problem.id].judge_id;
          } else {
            problem.status = null;
          }
        }
      }
    }

    let hasStatistics = false;
    if ((!contest.hide_statistics) || (contest.ended) || (isSupervisior)) {
      hasStatistics = true;

      await contest.loadRelationships();
      let players = await contest.ranklist.getPlayers();
      for (let problem of problems) {
        problem.statistics = { attempt: 0, accepted: 0 };

        if (contest.type === 'ioi' || contest.type === 'noi') {
          problem.statistics.partially = 0;
        }

        for (let player of players) {
          if (player.score_details[problem.problem.id]) {
            problem.statistics.attempt++;
            if ((contest.type === 'acm' && player.score_details[problem.problem.id].accepted) || ((contest.type === 'noi' || contest.type === 'ioi') && player.score_details[problem.problem.id].score === 100)) {
              problem.statistics.accepted++;
            }

            if ((contest.type === 'noi' || contest.type === 'ioi') && player.score_details[problem.problem.id].score > 0) {
              problem.statistics.partially++;
            }
          }
        }
      }
    }

    res.render('contest', {
      contest: contest,
      problems: problems,
      hasStatistics: hasStatistics,
      isSupervisior: isSupervisior,
      hasPermissionManage: res.locals.user && await res.locals.user.hasPrivilege('manage_problem')
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});

app.get('/contest/:id/ranklist', async (req, res) => {
  try {
    let contest_id = parseInt(req.params.id);
    let contest = await Contest.findById(contest_id);
    const curUser = res.locals.user;

    if (!contest) throw new ErrorMessage('无此比赛。');
    // if contest is non-public, both system administrators and contest administrators can see it.
    if (!await contest.isAllowedUseBy(res.locals.user)) throw new ErrorMessage('您没有权限进行此操作。');
    if (!contest.is_public && (!res.locals.user || !(await contest.isAllowedManageBy(curUser)))) throw new ErrorMessage('比赛未公开，请耐心等待 (´∀ `)');
    if ([contest.allowedSeeingResult() && contest.allowedSeeingOthers(),
    contest.isEnded(),
    await contest.isAllowedManageBy(curUser)].every(x => !x))
      throw new ErrorMessage('您没有权限进行此操作。');

    await contest.loadRelationships();

    let players_id = [];
    for (let i = 1; i <= contest.ranklist.ranklist.player_num; i++) players_id.push(contest.ranklist.ranklist[i]);

    let ranklist = await players_id.mapAsync(async player_id => {
      let player = await ContestPlayer.findById(player_id);

      if (contest.type === 'noi' || contest.type === 'ioi') {
        player.score = 0;
      }

      for (let i in player.score_details) {
        player.score_details[i].judge_state = await JudgeState.findById(player.score_details[i].judge_id);

        /*** XXX: Clumsy duplication, see ContestRanklist::updatePlayer() ***/
        if (contest.type === 'noi' || contest.type === 'ioi') {
          let multiplier = (contest.ranklist.ranking_params || {})[i] || 1.0;
          player.score_details[i].weighted_score = player.score_details[i].score == null ? null : Math.round(player.score_details[i].score * multiplier);
          player.score += player.score_details[i].weighted_score;
        }
      }

      let user = await User.findById(player.user_id);

      return {
        user: user,
        player: player
      };
    });

    let problems_id = await contest.getProblems();
    let problems = await problems_id.mapAsync(async id => await Problem.findById(id));

    res.render('contest_ranklist', {
      contest: contest,
      ranklist: ranklist,
      problems: problems,
      show_realname: res.locals.user && (await res.locals.user.hasPrivilege('see_realname'))
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});

app.get('/contest/:id/ranklist2', async (req, res) => {
  try {
    let contest_id = parseInt(req.params.id);
    let contest = await Contest.findById(contest_id);
    const curUser = res.locals.user;

    if (!contest) throw new ErrorMessage('无此比赛。');
    if (!await contest.isAllowedUseBy(res.locals.user)) throw new ErrorMessage('您没有权限进行此操作。');
    if (!contest.is_public && (!res.locals.user || !(await contest.isAllowedManageBy(curUser)))) throw new ErrorMessage('比赛未公开，请耐心等待 (´∀ `)');
    if ([contest.allowedSeeingResult() && contest.allowedSeeingOthers(),
    contest.isEnded(),
    await contest.isAllowedManageBy(curUser)].every(x => !x))
      throw new ErrorMessage('您没有权限进行此操作。');

    await contest.loadRelationships();

    let players_id = [];
    for (let i = 1; i <= contest.ranklist2.ranklist.player_num; i++) players_id.push(contest.ranklist2.ranklist[i]);

    let ranklist = await players_id.mapAsync(async player_id => {
      let player = await ContestPlayer.findById(player_id);

      if (contest.type === 'noi' || contest.type === 'ioi') {
        player.score = 0;
      }

      for (let i in player.score_details) {
		if (typeof player.score_details[i].judge_id == 'undefined') continue;
        player.score_details[i].judge_state = await JudgeState.findById(player.score_details[i].judge_id);

        /*** XXX: Clumsy duplication, see ContestRanklist::updatePlayer() ***/
        if (contest.type === 'noi' || contest.type === 'ioi') {
          let multiplier = (contest.ranklist2.ranking_params || {})[i] || 1.0;
          player.score_details[i].weighted_score = player.score_details[i].score == null ? null : Math.round(player.score_details[i].score * multiplier);
          player.score += player.score_details[i].weighted_score;
        }
      }

      let user = await User.findById(player.user_id);

      return {
        user: user,
        player: player
      };
    });

    let problems_id = await contest.getProblems();
    let problems = await problems_id.mapAsync(async id => await Problem.findById(id));

    res.render('contest_ranklist', {
      contest: contest,
      ranklist: ranklist,
      problems: problems,
      show_realname: res.locals.user && (await res.locals.user.hasPrivilege('see_realname'))
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});

function getDisplayConfig(contest) {
  return {
    showScore: contest.allowedSeeingScore(),
    showUsage: false,
    showCode: false,
    showResult: contest.allowedSeeingResult(),
    showOthers: contest.allowedSeeingOthers(),
    showDetailResult: contest.allowedSeeingTestcase(),
    showTestdata: false,
    inContest: true,
    showRejudge: false
  };
}

app.get('/contest/:id/submissions', async (req, res) => {
  try {
    let contest_id = parseInt(req.params.id);
    let contest = await Contest.findById(contest_id);
    const curUser = res.locals.user;

    // if contest is non-public, both system administrators and contest administrators can see it.
    if (!contest) throw new ErrorMessage('无此比赛。');
    if (!await contest.isAllowedUseBy(curUser)) throw new ErrorMessage('您没有权限进行此操作。');
    if (!contest.is_public && (!curUser || !(await contest.isAllowedManageBy(curUser)))) throw new ErrorMessage('比赛未公开，请耐心等待 (´∀ `)');

    if (contest.isEnded()) {
      res.redirect(syzoj.utils.makeUrl(['submissions'], { contest: contest_id }));
      return;
    }

    const displayConfig = getDisplayConfig(contest);
    let problems_id = await contest.getProblems();

    let user = req.query.submitter && await User.fromName(req.query.submitter);

    let query = JudgeState.createQueryBuilder();

    let isFiltered = false;
    if (displayConfig.showOthers) {
      if (user) {
        query.andWhere('user_id = :user_id', { user_id: user.id });
        isFiltered = true;
      }
    } else {
      if (curUser == null || // Not logined
        (user && user.id !== curUser.id)) { // Not querying himself
        throw new ErrorMessage("您没有权限执行此操作。");
      }
      query.andWhere('user_id = :user_id', { user_id: curUser.id });
      isFiltered = true;
    }

    if (displayConfig.showScore) {
      let minScore = parseInt(req.body.min_score);
      if (!isNaN(minScore)) query.andWhere('score >= :minScore', { minScore });
      let maxScore = parseInt(req.body.max_score);
      if (!isNaN(maxScore)) query.andWhere('score <= :maxScore', { maxScore });

      if (!isNaN(minScore) || !isNaN(maxScore)) isFiltered = true;
    }

    if (req.query.language) {
      if (req.body.language === 'submit-answer') {
        query.andWhere(new TypeORM.Brackets(qb => {
          qb.orWhere('language = :language', { language: '' })
            .orWhere('language IS NULL');
        }));
      } else if (req.body.language === 'non-submit-answer') {
        query.andWhere('language != :language', { language: '' })
             .andWhere('language IS NOT NULL');
      } else {
        query.andWhere('language = :language', { language: req.body.language })
      }
      isFiltered = true;
    }

    if (displayConfig.showResult) {
      if (req.query.status) {
        query.andWhere('status = :status', { status: req.query.status });
        isFiltered = true;
      }
    }

    if (req.query.problem_id) {
      problem_id = problems_id[parseInt(req.query.problem_id) - 1] || 0;
      query.andWhere('problem_id = :problem_id', { problem_id })
      isFiltered = true;
    }

    query.andWhere('type = 1')
         .andWhere('type_info = :contest_id', { contest_id });

    let judge_state, paginate;

    if (syzoj.config.submissions_page_fast_pagination) {
      const queryResult = await JudgeState.queryPageFast(query, syzoj.utils.paginateFast(
        req.query.currPageTop, req.query.currPageBottom, syzoj.config.page.judge_state
      ), -1, parseInt(req.query.page));

      judge_state = queryResult.data;
      paginate = queryResult.meta;
    } else {
      paginate = syzoj.utils.paginate(
        await JudgeState.countQuery(query),
        req.query.page,
        syzoj.config.page.judge_state
      );
      judge_state = await JudgeState.queryPage(paginate, query, { id: "DESC" }, true);
    }

    await judge_state.forEachAsync(async obj => {
      await obj.loadRelationships();
      obj.problem_id = problems_id.indexOf(obj.problem_id) + 1;
      obj.problem.title = syzoj.utils.removeTitleTag(obj.problem.title);
    });

    const pushType = displayConfig.showResult ? 'rough' : 'compile';
    res.render('submissions', {
      vjudge: require("../libs/vjudge"),
      contest: contest,
      items: judge_state.map(x => ({
        info: getSubmissionInfo(x, displayConfig),
        token: (getRoughResult(x, displayConfig) == null && x.task_id != null) ? jwt.sign({
          taskId: x.task_id,
          type: pushType,
          displayConfig: displayConfig
        }, syzoj.config.session_secret) : null,
        result: getRoughResult(x, displayConfig),
        running: false,
      })),
      paginate: paginate,
      form: req.query,
      displayConfig: displayConfig,
      pushType: pushType,
      isFiltered: isFiltered,
      fast_pagination: syzoj.config.submissions_page_fast_pagination
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});


app.get('/contest/submission/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const judge = await JudgeState.findById(id);
    if (!judge) throw new ErrorMessage("提交记录 ID 不正确。");
    const curUser = res.locals.user;
    const contest = await Contest.findById(judge.type_info);
    contest.ended = contest.isEnded();

    if (!contest) throw new ErrorMessage('无此比赛。');
    if (!await contest.isAllowedUseBy(curUser)) throw new ErrorMessage('您没有权限进行此操作。');
    if (!contest.is_public && (!curUser || !(await contest.isAllowedManageBy(curUser)))) throw new ErrorMessage('比赛未公开，请耐心等待 (´∀ `)');

    if ((!curUser) || (judge.user_id !== curUser.id && !(await contest.isAllowedManageBy(curUser)))) throw new ErrorMessage("您没有权限执行此操作。");

    if (judge.type !== 1) {
      return res.redirect(syzoj.utils.makeUrl(['submission', id]));
    }

    const displayConfig = getDisplayConfig(contest);
    displayConfig.showCode = true;

    await judge.loadRelationships();
    const problems_id = await contest.getProblems();
    judge.problem_id = problems_id.indexOf(judge.problem_id) + 1;
    judge.problem.title = syzoj.utils.removeTitleTag(judge.problem.title);

    if (judge.problem.type !== 'submit-answer') {
      judge.codeLength = Buffer.from(judge.code).length;
      judge.code = await syzoj.utils.highlight(judge.code, (judge.problem.getVJudgeLanguages() || syzoj.languages)[judge.language].highlight);
    }

    res.render('submission', {
      info: getSubmissionInfo(judge, displayConfig),
      roughResult: getRoughResult(judge, displayConfig),
      code: (displayConfig.showCode && judge.problem.type !== 'submit-answer') ? judge.code.toString("utf8") : '',
      formattedCode: judge.formattedCode ? judge.formattedCode.toString("utf8") : null,
      preferFormattedCode: res.locals.user ? res.locals.user.prefer_formatted_code : false,
      detailResult: processOverallResult(judge.result, displayConfig),
      socketToken: (displayConfig.showDetailResult && judge.pending && judge.task_id != null) ? jwt.sign({
        taskId: judge.task_id,
        displayConfig: displayConfig,
        type: 'detail'
      }, syzoj.config.session_secret) : null,
      displayConfig: displayConfig,
      contest: contest,
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});

app.get('/contest/:id/problem/:pid', async (req, res) => {
  try {
    let contest_id = parseInt(req.params.id);
    let contest = await Contest.findById(contest_id);
    const curUser = res.locals.user;

    if (!contest) throw new ErrorMessage('无此比赛。');
    if (contest.read_rating && !res.locals.user) throw new ErrorMessage('请先登录');
    if (!await contest.isAllowedUseBy(res.locals.user)) throw new ErrorMessage('您没有权限进行此操作。');
    if (!contest.is_public && (!res.locals.user || !(await contest.isAllowedManageBy(curUser)))) throw new ErrorMessage('比赛未公开，请耐心等待 (´∀ `)');

    let problems_id = await contest.getProblems();

    let pid = parseInt(req.params.pid);
    if (!pid || pid < 1 || pid > problems_id.length) throw new ErrorMessage('无此题目。');

    let problem_id = problems_id[pid - 1];
    let problem = await Problem.findById(problem_id);
    await problem.loadRelationships();

    contest.ended = contest.isEnded();
    if (!await contest.isSupervisior(curUser) && !(contest.isRunning() || contest.isEnded())) {
      if (await problem.isAllowedUseBy(res.locals.user)) {
        return res.redirect(syzoj.utils.makeUrl(['problem', problem_id]));
      }
      throw new ErrorMessage('比赛尚未开始。');
    }

    if (contest.read_rating && contest.isRunning() && !await contest.isAllowedManageBy(curUser)) {
      await contest.loadRelationships();
      let player = await ContestPlayer.findInContest({
        contest_id: contest.id,
        user_id: curUser.id
      });
      if (!player) {
        player = await ContestPlayer.create({
          contest_id: contest.id,
          user_id: curUser.id
        });
        await player.save();
        await contest.ranklist.updatePlayer(contest, player);
        await contest.ranklist.save();
      }
      let player2 = await ContestPlayer.findInContest({
        contest_id: -contest.id,
        user_id: curUser.id
      });
      if (!player2) {
        player2 = await ContestPlayer.create({
          contest_id: -contest.id,
          user_id: curUser.id
        });
        await player2.save();
        await contest.ranklist2.updatePlayer(contest, player2);
        await contest.ranklist2.save();
      }
    }

    problem.specialJudge = await problem.hasSpecialJudge();

    await syzoj.utils.markdown(problem, ['description', 'input_format', 'output_format', 'example', 'limit_and_hint']);

    let state = await problem.getJudgeState(res.locals.user, false);
    let testcases = await syzoj.utils.parseTestdata(problem.getTestdataPath(), problem.type === 'submit-answer');

    await problem.loadRelationships();

    res.render('problem', {
      pid: pid,
      contest: contest,
      problem: problem,
      state: state,
      lastLanguage: res.locals.user ? await res.locals.user.getLastSubmitLanguage() : null,
      testcases: testcases,
      languages: problem.getVJudgeLanguages()
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});

app.get('/contest/:id/:pid/download/additional_file', async (req, res) => {
  try {
    let id = parseInt(req.params.id);
    let contest = await Contest.findById(id);
    const curUser = res.locals.user;

    if (!contest) throw new ErrorMessage('无此比赛。');
    if (!await contest.isAllowedUseBy(res.locals.user)) throw new ErrorMessage('您没有权限进行此操作。');
    if (!contest.is_public && (!res.locals.user || !(await contest.isAllowedManageBy(curUser)))) throw new ErrorMessage('比赛未公开，请耐心等待 (´∀ `)');

    let problems_id = await contest.getProblems();

    let pid = parseInt(req.params.pid);
    if (!pid || pid < 1 || pid > problems_id.length) throw new ErrorMessage('无此题目。');

    let problem_id = problems_id[pid - 1];
    let problem = await Problem.findById(problem_id);

    contest.ended = contest.isEnded();
    if (!(contest.isRunning() || contest.isEnded())) {
      if (await problem.isAllowedUseBy(res.locals.user)) {
        return res.redirect(syzoj.utils.makeUrl(['problem', problem_id, 'download', 'additional_file']));
      }
      throw new ErrorMessage('比赛尚未开始。');
    }

    await problem.loadRelationships();

    if (!problem.additional_file) throw new ErrorMessage('无附加文件。');

    res.download(problem.additional_file.getPath(), `additional_file_${id}_${pid}.zip`);
  } catch (e) {
    syzoj.log(e);
    res.status(404);
    res.render('error', {
      err: e
    });
  }
});


app.get('/contest/:id/group', async (req, res) => {
  try {
    let id = parseInt(req.params.id) || 0;
    let contest = await Contest.findById(id);
    if (!contest) throw new ErrorMessage('无此比赛。');
    if (!res.locals.user || !await res.locals.user.hasPrivilege('manage_problem')) throw new ErrorMessage('您没有权限进行此操作。');

    let Groups = await contest.getGroups();

    res.render('contest_group', {
      groups: Groups,
      contest: contest
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});

app.post('/contest/:id/group', async (req, res) => {
  try {
    let id = parseInt(req.params.id) || 0;
    let contest = await Contest.findById(id);
    if (!contest) throw new ErrorMessage('无此比赛。');
    if (!res.locals.user || !await res.locals.user.hasPrivilege('manage_problem')) throw new ErrorMessage('您没有权限进行此操作。');
    if (!req.body.name) throw new ErrorMessage('不合法的组编号或组名称');

    let name = req.body.name.trim();
    await contest.addGroups(name);

    res.redirect(syzoj.utils.makeUrl(['contest', contest.id, 'group']));
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});

app.post('/contest/:id/group/delete/:gid', async (req, res) => {
  try {
    let id = parseInt(req.params.id) || 0;
    let contest = await Contest.findById(id);
    if (!contest) throw new ErrorMessage('无此比赛。');
    if (!res.locals.user || !await res.locals.user.hasPrivilege('manage_problem')) throw new ErrorMessage('您没有权限进行此操作。');

    await contest.delGroups(parseInt(req.params.gid));

    res.redirect(syzoj.utils.makeUrl(['contest', contest.id, 'group']));
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});
