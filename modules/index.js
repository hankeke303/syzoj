let User = syzoj.model('user');
let Article = syzoj.model('article');
let Contest = syzoj.model('contest');
let Problem = syzoj.model('problem');
let Divine = syzoj.lib('divine');
let TimeAgo = require('javascript-time-ago');
let zh = require('../libs/timeago');
TimeAgo.locale(zh);
const timeAgo = new TimeAgo('zh-CN');

app.get('/', async (req, res) => {
  try {
    let ranklist = await User.queryRange([1, syzoj.config.page.ranklist_index], { is_show: true }, {
      [syzoj.config.sorting.ranklist.field]: syzoj.config.sorting.ranklist.order
    });
    await ranklist.forEachAsync(async x => x.renderInformation());

    let notices = (await Article.find({
      where: { is_notice: true }, 
      order: { public_time: 'DESC' }
    })).map(article => ({
      title: article.title,
      url: syzoj.utils.makeUrl(['article', article.id]),
      date: syzoj.utils.formatDate(article.public_time, 'L')
    }));

    let fortune = null;
    if (res.locals.user && syzoj.config.divine) {
      fortune = Divine(res.locals.user.username, res.locals.user.sex);
    }

    let query = 'SELECT * FROM `contest` WHERE\n';
    query += '`contest`.`is_public` = 1 ';
    if (!res.locals.user || !await res.locals.user.hasPrivilege('manage_problem')) {
      if (res.locals.user) {
        let user_have = (await res.locals.user.getGroups()).map(x => x.id);
        let user_has = await user_have.toString();
        if (user_have.length == 0) user_has = 'NULL';
        query += 'AND (EXISTS (SELECT * FROM contest_group_map WHERE contest_id = id and group_id in (' + user_has + '))' +
               'OR NOT EXISTS (SELECT * FROM contest_group_map WHERE contest_id = id))';
      } else {
        query += 'AND NOT EXISTS (SELECT * FROM contest_group_map WHERE contest_id = id)';
      }
    }

    let contests = await Problem.query(query + ` ORDER BY start_time DESC` + ` LIMIT 5`);

    let sql = 'SELECT * FROM `problem` WHERE\n';
    sql += '`problem`.`is_public` = 1 ';
    if (!res.locals.user || !await res.locals.user.hasPrivilege('manage_problem')) {
      if (res.locals.user) {
        let user_have = (await res.locals.user.getGroups()).map(x => x.id);
        let user_has = await user_have.toString();
        if (user_have.length == 0) user_has = 'NULL';
        sql += 'AND (EXISTS (SELECT * FROM problem_group_map WHERE problem_id = id and group_id in (' + user_has + '))' +
               'OR NOT EXISTS (SELECT * FROM problem_group_map WHERE problem_id = id))';
      } else {
        sql += 'AND NOT EXISTS (SELECT * FROM problem_group_map WHERE problem_id = id)';
      }
    }

    let problems = (await Problem.query(sql + ` ORDER BY publicize_time DESC` + ` LIMIT 5`)).map(problem => ({
      id: problem.id,
      title: problem.title,
      time: timeAgo.format(new Date(problem.publicize_time)),
    }));

    res.render('index', {
      ranklist: ranklist,
      notices: notices,
      fortune: fortune,
      contests: contests,
      problems: problems,
      links: syzoj.config.links,
      show_realname: res.locals.user && (await res.locals.user.hasPrivilege('see_realname'))
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});

app.get('/help', async (req, res) => {
  try {
    res.render('help');
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});
