import * as TypeORM from "typeorm";
import Model from "./common";

declare var syzoj, ErrorMessage: any;

import JudgeState from "./judge_state";
import UserPrivilege from "./user_privilege";
import Article from "./article";
import Group from "./group";
import UserGroupMap from "./user_group_map";

@TypeORM.Entity()
export default class User extends Model {
  static cache = true;

  @TypeORM.PrimaryGeneratedColumn()
  id: number;

  @TypeORM.Index({ unique: true })
  @TypeORM.Column({ nullable: true, type: "varchar", length: 80 })
  username: string;

  @TypeORM.Column({ nullable: true, type: "varchar", length: 120 })
  email: string;

  @TypeORM.Column({ nullable: true, type: "varchar", length: 120 })
  password: string;

  @TypeORM.Column({ nullable: true, type: "varchar", length: 80 })
  nickname: string;

  @TypeORM.Column({ nullable: true, type: "varchar", length: 80 })
  realname: string;

  @TypeORM.Column({ nullable: true, type: "text" })
  nameplate: string;

  @TypeORM.Column({ nullable: true, type: "text" })
  information: string;

  @TypeORM.Index()
  @TypeORM.Column({ nullable: true, type: "integer" })
  ac_num: number;

  @TypeORM.Index()
  @TypeORM.Column({ nullable: true, type: "integer" })
  submit_num: number;

  @TypeORM.Column({ nullable: true, type: "boolean" })
  is_admin: boolean;

  @TypeORM.Index()
  @TypeORM.Column({ nullable: true, type: "boolean" })
  is_show: boolean;

  @TypeORM.Column({ nullable: true, type: "boolean", default: true })
  public_email: boolean;

  @TypeORM.Column({ nullable: true, type: "boolean", default: true })
  prefer_formatted_code: boolean;

  @TypeORM.Column({ nullable: true, type: "boolean", default: false })
  disable_login: boolean;

  @TypeORM.Column({ nullable: true, type: "integer" })
  sex: number;

  @TypeORM.Column({ nullable: true, type: "integer" })
  rating: number;

  @TypeORM.Column({ nullable: true, type: "integer" })
  register_time: number;

  @TypeORM.Column({ nullable: true, type: "text" })
  ip_address: string;

  @TypeORM.Column({ nullable: true, type: "integer" })
  last_seeing: number;

  static async fromEmail(email): Promise<User> {
    return User.findOne({
      where: {
        email: String(email)
      }
    });
  }

  static async fromName(name): Promise<User> {
    return User.findOne({
      where: {
        username: String(name)
      }
    });
  }

  async isAllowedEditBy(user) {
    if (!user) return false;
    if (await user.hasPrivilege('manage_user')) return true;
    return user && (user.is_admin || this.id === user.id);
  }

  getQueryBuilderForACProblems() {
    return JudgeState.createQueryBuilder()
                     .select(`DISTINCT(problem_id)`)
                     .where('user_id = :user_id', { user_id: this.id })
                     .andWhere('status = :status', { status: 'Accepted' })
                     .andWhere('type != 1')
                     .orderBy({ problem_id: 'ASC' })
  }

  async refreshSubmitInfo() {
    await syzoj.utils.lock(['User::refreshSubmitInfo', this.id], async () => {
      this.ac_num = await JudgeState.countQuery(this.getQueryBuilderForACProblems());
      this.submit_num = await JudgeState.count({
        user_id: this.id,
        type: TypeORM.Not(1) // Not a contest submission
      });

      await this.save();
    });
  }

  async getACProblems() {
    let queryResult = await this.getQueryBuilderForACProblems().getRawMany();

    return queryResult.map(record => record['problem_id'])
  }

  async getArticles() {
    return await Article.find({
      where: {
        user_id: this.id
      }
    });
  }

  async getStatistics() {
    let statuses = {
      "Accepted": ["Accepted"],
      "Wrong Answer": ["Wrong Answer", "File Error", "Output Limit Exceeded"],
      "Runtime Error": ["Runtime Error"],
      "Time Limit Exceeded": ["Time Limit Exceeded"],
      "Memory Limit Exceeded": ["Memory Limit Exceeded"],
      "Compile Error": ["Compile Error"]
    };

    let res = {};
    for (let status in statuses) {
      res[status] = 0;
      for (let s of statuses[status]) {
        res[status] += await JudgeState.count({
          user_id: this.id,
          type: 0,
          status: s
        });
      }
    }

    return res;
  }

  async renderInformation() {
    this.information = await syzoj.utils.markdown(this.information);
  }

  async getPrivileges() {
    let privileges = await UserPrivilege.find({
      where: {
        user_id: this.id
      }
    });

    return privileges.map(x => x.privilege);
  }

  async setPrivileges(newPrivileges) {
    let oldPrivileges = await this.getPrivileges();

    let delPrivileges = oldPrivileges.filter(x => !newPrivileges.includes(x));
    let addPrivileges = newPrivileges.filter(x => !oldPrivileges.includes(x));

    for (let privilege of delPrivileges) {
      let obj = await UserPrivilege.findOne({ where: {
        user_id: this.id,
        privilege: privilege
      } });

      await obj.destroy();
    }

    for (let privilege of addPrivileges) {
      let obj = await UserPrivilege.create({
        user_id: this.id,
        privilege: privilege
      });

      await obj.save();
    }
  }

  async hasPrivilege(privilege) {
    if (this.is_admin) return true;

    let x = await UserPrivilege.findOne({ where: { user_id: this.id, privilege: privilege } });
    return !!x;
  }

  async getLastSubmitLanguage() {
    let a = await JudgeState.findOne({
      where: {
        user_id: this.id
      },
      order: {
        submit_time: 'DESC'
      }
    });
    if (a) return a.language;

    return null;
  }

  async getGroupsFull() {
    let maps = await UserGroupMap.find({
      where: {
        user_id: this.id
      }
    });

    maps.sort((a, b) => {
      return a.level < b.level ? 1 : -1;
    });

    return maps;
  }

  async getGroups() {
    let GroupIDs;
    
    let maps = await UserGroupMap.find({
      where: {
        user_id: this.id
      }
    });

    GroupIDs = maps.map(x => x.group_id);

    let res = await (GroupIDs as any).mapAsync(async GroupID => {
      return Group.findById(GroupID);
    });

    res.sort((a, b) => {
      return a.id > b.id ? 1 : -1;
    });

    return res;
  }

  async addGroups(newGroupID, level) {
    let oldGroupIDs = (await this.getGroups()).map(x => x.name);

    if (oldGroupIDs.includes(newGroupID)) {
      let pos = await Group.findOne({
        where: {
          name: newGroupID
        }
      });
      let map = await UserGroupMap.findOne({
        user_id: this.id,
        group_id: pos.id
      });
      map.level = level;
      await map.save();
      return;
    }

    let pos = await Group.findOne({
      where: {
        name: newGroupID
      }
    });

    if (!pos) throw new ErrorMessage('不存在此组名称');

    let map = await UserGroupMap.create({
      user_id: this.id,
      group_id: pos.id,
      level: level
    });

    await map.save();
  }

  async delGroups(delGroupID) {
    let oldGroupIDs = (await this.getGroups()).map(x => x.id);

    if (!oldGroupIDs.includes(delGroupID)) throw new ErrorMessage('此用户不属于该用户组。');
  
    let map = await UserGroupMap.findOne({
      where: {
        user_id: this.id,
        group_id: delGroupID
      }
    });

    await map.destroy();
  }

  async getMaxLevelInProblem(problem) {
    if (await this.hasPrivilege('manage_problem')) return 2;

    let usergroup = (await this.getGroupsFull());
    let problemgroup = (await problem.getGroups()).map(x => x.id);

    for (let groupi of usergroup) {
      if (problemgroup.includes(groupi.group_id))
        return groupi.level;
    }

    return -1;
  }

  async getLevelInGroup(groupID) {
    let map = await UserGroupMap.findOne({
      where: {
        user_id: this.id,
        group_id: groupID
      }
    });
    return map.level;
  }

  async getPermissionInContest(contest) {
    if (await this.hasPrivilege('manage_problem')) return 2;

    let usergroup = (await this.getGroupsFull());
    let contestgroup = (await contest.getGroups()).map(x => x.id);

    for (let groupi of usergroup) {
      if (contestgroup.includes(groupi.group_id)) return true;
    }

    return false;
  }
}
