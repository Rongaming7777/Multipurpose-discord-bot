//Import npm modules
const { Collection, MessageEmbed, MessageAttachment, Permissions } = require("discord.js");
const MilratoCanvasApi = require("./CanvasApi");
// require functions from files
const config = require(`${process.cwd()}/botconfig/config.json`);
const ee = require(`${process.cwd()}/botconfig/embed.json`);
const { delay, duration, dbEnsure} = require(`./functions`);
const { Captcha } = require(`captcha-canvas`); //require package here
const ms = require("ms");
//Create Variables
let invitemessage = "\u200b";
const { inviteationCache, DbAllCache } = require("./caches");

//Start the module
module.exports = async (client) => {
  client.fetched = false;
  
  /**
   * FETCH THE INVITES OF ALL GUILDS
   */
  client.on("ready", async () => {
    for await (const guild of [...client.guilds.cache.values()]){
      try{
        let fetchedInvites = null;
        if (guild.me.permissions.has(Permissions.FLAGS.MANAGE_GUILD)) {
          await guild.invites.fetch().catch(() => null);
        }
        fetchedInvites = generateInvitesCache(guild.invites.cache);
        inviteationCache.set(guild.id, fetchedInvites);
      }catch(e){
        console.error(e)
      }
    }
    client.fetched = true;
    
    const allData = await client.invitesdb.all();
    client.guilds.cache.each(async g => {
      // Update the invitesDb cache
      DbAllCache.set(g.id, allData.filter(v => v.data?.guildId == g.id))
    })
  })

  /**
   * FETCH THE INVITES OF THAT GUILD
   */
  client.on("guildCreate", async (guild) => {
      let fetchedInvites = null;
      if (guild.me.permissions.has(Permissions.FLAGS.MANAGE_GUILD)) {
        await guild.invites.fetch().catch(() => null);
      }
      fetchedInvites = generateInvitesCache(guild.invites.cache);
      inviteationCache.set(guild.id, fetchedInvites);
  })

  /**
   * Register new Created Invites
   */
  client.on("inviteCreate", (i) => {
    if(!i.guild) return;
    function SetInvite(invite){
      if (!client.fetched && !inviteationCache.has(invite.guild.id)) 
        return setTimeout(() => SetInvite(invite), 5_000)
      
      inviteationCache.get(invite.guild.id).set(invite.code, inviteToJson(invite));
    }
    SetInvite(i)
  })
  /**
   * Handle Invite Delete Event
   */
  client.on("inviteDelete", (i) => {
    if(!i.guild) return;
    function SetInvite(invite){
      if (!client.fetched && !inviteationCache.has(invite.guild.id)) 
        return setTimeout(() => SetInvite(invite), 5_000)
      
      if(inviteationCache.get(invite.guild.id) && inviteationCache.get(invite.guild.id).get(invite.code)) {
        inviteationCache.get(invite.guild.id).get(invite.code).deletedTimestamp = Date.now();
      }
    }
    SetInvite(i)
  })

  /**
   * if a User leaves, remove him from the db
   * Done in: ./leave.js
   */
  

  /**
   * WELCOMING + Register the Invites etc.
   */
  client.on("guildMemberAdd", async mem => {
    // If not in a guild or a bot got added return
    if (!mem.guild || mem.user.bot) return;
    // Make sure that it's in the db
    await dbEnsure(client.settings, mem.guild.id, getDefaultWelcomeData()).catch(console.warn);
    // get the settings
    const theSettings = await client.settings.get(mem.guild.id);
    // if there are not settings, or no welcome settings return
    if(!theSettings || !theSettings.welcome) return 
    // Settings Data
    const ls = theSettings.language || "en";
    const es = theSettings.embed || ee;
    // Execute the Welcome Function
    welcome(mem);
    async function welcome(member) {
      // If guild is not in the cache yet, wait 5 Seconds and then retry
      if (!client.fetched && !inviteationCache.has(member.guild.id)) 
        return setTimeout(() => welcome(member), 5_000)

      // Fetch guild and member data from the db
      await EnsureInviteDB(member.guild, member.user)

      const allData = DbAllCache.get(member.guild.id) || await client.invitesdb.all().then(v => v.filter(d => d.data?.guildId == member.guild.id)) || [];
      DbAllCache.set(member.guild.id, allData);

      const memberData = allData.find(v => v.data?.id == member.id && v.data?.guildId == member.guild.id && v.data?.bot == member.user.bot)?.data || {};
      const memberDataKey = allData.find(v => v.data?.id == member.id && v.data?.guildId == member.guild.id && v.data?.bot == member.user.bot)?.ID || `${member.guild.id + member.id}`;
      
      let invite = null, vanity = false, perm = false; 

      //if i dont exist in the guild fetch me
      if (!member.guild.me) await member.guild.members.fetch({ user: client.user.id, cache: true }).catch(() => null);
      
      //if not allowed set perm to true
      if (!member.guild.me.permissions.has("MANAGE_GUILD")) perm = true;
      
      // if i am allowed to do so then start
      if (!perm) {
        // Fetch the current invites of the guild
        const currentInvites = await member.guild.invites.fetch().catch(() => new Collection());
        const currentInvitesData = generateInvitesCache(currentInvites);
        //get the old GUild INvites
        const oldGuildInvites = inviteationCache.get(member.guild.id);
        // update the cache Data
        if(currentInvitesData) inviteationCache.set(member.guild.id, currentInvitesData);
        
        if (currentInvitesData && oldGuildInvites) {
          // Find the invitations which doesn't have the same number of use
          let inviteUsed = compareOldWithNew(oldGuildInvites, currentInvitesData); 
          
          // if it's a vanity code          
          if ((isEqual(oldGuildInvites.map((i) => `${i?.code}|${i?.uses}` ).sort(), currentInvitesData.map((i) => `${i?.code}|${i?.uses}` ).sort())) && !inviteUsed && member.guild.features.includes("VANITY_URL")){
            vanity = true;
          } 

          if (!inviteUsed || inviteUsed.length == 0){
              const newAndUsed = currentInvitesData.filter((i) => !oldGuildInvites.get(i?.code) && i?.uses >= 1);
              if (newAndUsed.size >= 1){
                  inviteUsed = [newAndUsed.first()];
              }
          }
          if (inviteUsed && !vanity) invite = inviteUsed[0];
        }

        //if there wasn't an invite found, yet
        if (!invite && currentInvitesData){
            // try to find the inviter
            const targetInvite = currentInvitesData.find((i) => i?.targetUser && (i?.targetUser.id === member.id));
            const oldTargetCache = oldGuildInvites.get(targetInvite?.code) || null;
            if ((targetInvite && !oldTargetCache) || (targetInvite && oldTargetCache && targetInvite.uses > oldTargetCache.uses)) {
                invite = targetInvite;
            }
        }
      }

      const inviter = invite && invite.inviter ? invite.inviter : null;

      let inviterData;
      let inviterDataKey;
      //if there is an inviter, ensure the database
      if (inviter) {
        //ensure him in the database
        await EnsureInviteDB(member.guild, inviter)
        //get the inviterData
        inviterData = inviter ? allData.find(v => v.data?.id == inviter.id && v.data?.guildId == member.guild.id)?.data : {id: inviter.id, guildId: member.guild.id,fake: 0,leaves: 0,invites: 0,invited: [],left: [],joinData: { type: "unknown", invite: null }, messagesCount: 0,bot: inviter.bot};
        inviterDataKey = allData.find(v => v.data?.id == inviter.id && v.data?.guildId == member.guild.id && v.data?.bot == inviter.bot)?.ID || inviter.id + member.guild.id
        if(inviterData){
        //make sure that the inviter Data is an array 
          if(!inviterData.left || !Array.isArray(inviterData.left)) {
            inviterData.left = [];
          }
          if(!inviterData.invited || !Array.isArray(inviterData.invited)) {
            inviterData.invited = [];
          }
          // If the member was a rejoin, remove it from whom invited him before
          if (inviterData.left.includes(member.id)) {
            // We`re removing a leave
            inviterData.leaves--;
            //Setting it back to 0 if its less then 0
            if(inviterData.leaves < 0) inviterData.leaves = 0;
          }

          // FAKEINVITE - If the member had already invited this member before
          if (inviterData.invited.includes(member.id)) {
            // We increase the number of fake invitations
            inviterData.fake++;
          } 
          if(!inviterData.invited.includes(member.id))
          inviterData.invited.push(member.id);

          // We increase the number of regular invitations
          inviterData.invites++;
          //update the database
          await client.invitesdb.set(inviterDataKey, inviterData)
        }
      }  

      /**
       * @INFO CHANGE THE MEMBERDATA TO WHOM INVITED HIM
       */
      if (invite) {
        memberData.joinData = {
          type: "normal",
          invite: {
            uses: invite.uses,
            code: invite.code,
            inviter: inviter ? inviter.id : null
          }
        };
      } else if (vanity) {
        memberData.joinData = {
          type: "vanity",
          invite: null
        }
      } else if (perm) {
        memberData.joinData = {
          type: "perm",
          invite: null
        }
      }


      //update the database for the MEMBER
      await client.invitesdb.set(memberDataKey, memberData)
      
      if (invite && inviter) {
        //get the new memberdata
        let {
          invites,
          fake,
          leaves
         } = inviterData || await client.invitesdb.get(member.guild.id + inviter.id);
        if(fake < 0) fake *= -1;
        if(leaves < 0) leaves *= -1;
        if(invites < 0) invites *= -1;
        let realinvites = invites - fake - leaves;
        invitemessage = `Invited by ${inviter.tag ? `**${inviter.tag}**` : `<@${inviter.id}>`}\n<:Like:857334024087011378> **${realinvites} Invite${realinvites == 1 ? "" : "s"}**\n[<:joines:866356465299488809> ${invites} Joins | <:leaves:866356598356049930> ${leaves} Leaves | <:no:833101993668771842> ${fake} Fakes]`;
      } 
      else if(invite){
        invitemessage = `Invited by an **Unknown Member**`
      }
      else if (vanity) {
        try{
          let res = await member.guild.fetchVanityData().catch(() => null);
          if(res){
            invitemessage = `Invited by a **[Vanity URL](https://discord.gg/${res.code})** with \`${res.uses} Uses\``
          } else {
            invitemessage = `Invited by a **Vanity Link!**`;
          }
        }catch (e){
          console.error(e)
          invitemessage = `Invited by a **Vanity Link!**`;
        }
      } else if (perm) {
        //get the new memberdata
        invitemessage = `I need the **Manage Server** Permission, to fetch Invites!`;
      } else {
        console.log("ELSE - NO INVITE INFOS ");
        invitemessage = "\u200b"
      }

      // Update the invitation cache
      (async() => {
        const allInvitesData = await client.invitesdb.all().then(v => v.filter(d => d.data?.guildId == member.guild.id)) || DbAllCache.get(member.guild.id) || [];
        DbAllCache.set(member.guild.id, allInvitesData);
      })();

      if (theSettings.welcome.captcha && !member.user.bot) {
        const captcha = new Captcha();
        captcha.async = true //Sync
        await captcha.addDecoy(); //Add decoy text on captcha canvas.
        await captcha.drawTrace(); //draw trace lines on captcha canvas.
        await captcha.drawCaptcha(); //draw captcha text on captcha canvas
        const buffer = await captcha.png; //returns buffer of the captcha image
        const attachment = new MessageAttachment(buffer, `${captcha.text}_Captcha.png`)
        //fin a muted role
        let mutedrole = member.guild.roles.cache.find(r => r.name.toLowerCase().includes("captcha")) || false;
        //if no muted role found, create a new one
        if (!mutedrole) {
          mutedrole = await member.guild.roles.create({
            name: `DISABLED - CAPTCHA`,
            color: `#222222`,
            hoist: true,
            position: member.guild.me.roles.highest.position - 1,
            reason: `This role got created, to DISABLED - CAPTCHA Members!`
          }).catch((e) => {
            console.error(e);
          });
        }
        //For each channel, not including the captcha role, change the permissions
        await mem.guild.channels.cache
            .filter(c => c.permissionOverwrites)
            .filter(c => 
              !c.permissionOverwrites.cache.has(mutedrole.id) || 
              (c.permissionOverwrites.cache.has(mutedrole.id) && !c.permissionOverwrites.cache.get(mutedrole.id).deny.toArray().includes("SEND_MESSAGES")) ||
              (c.permissionOverwrites.cache.has(mutedrole.id) && !c.permissionOverwrites.cache.get(mutedrole.id).deny.toArray().includes("ADD_REACTIONS"))
        ).forEach(async (ch) => {
          try {
            if(ch.permissionsFor(ch.guild.me).has(Permissions.FLAGS.MANAGE_CHANNELS)){
              await ch.permissionOverwrites.edit(mutedrole, {
                VIEW_CHANNEL: false,
                SEND_MESSAGES: false,
                ADD_REACTIONS: false,
                CONNECT: false,
                SPEAK: false
              }).catch(() => null);
              await delay(300);
            };
          } catch (e) {
            console.error(e);
          }
        });
        //Add the role
        member.roles.add(mutedrole.id).catch(() => null);
        const captchaembed = new MessageEmbed()
          .setColor(es.color).setThumbnail(es.thumb ? es.footericon && (es.footericon.includes("http://") || es.footericon.includes("https://")) ? es.footericon : client.user.displayAvatarURL() : null)
          .setTimestamp()
          .setFooter(client.getFooter(es))
          .setTitle(eval(client.la[ls]["handlers"]["welcomejs"]["welcome"]["variable1"]))
          .setDescription(eval(client.la[ls]["handlers"]["welcomejs"]["welcome"]["variable2"]))
        //Dm him

        member.send({content: `**${member.guild.name}** has a Captcha Security Option enabled!\n> Solve it first, by typing the WHOLE LETTERS of the IMAGE!`, embeds: [captchaembed], files: [attachment]}).then(msg => {
          msg.channel.awaitMessages({filter: m => m.author.id === member.user.id, 
            max: 1,
            time: 60000,
            errors: ["time"]
          }).then(async collected => {
            if (collected.first().content.trim().toLowerCase() == captcha.text.toLowerCase()) {
              //remove the role again
              member.roles.remove(mutedrole.id).catch(e => console.error(e))
              //Send the message to success
              await msg.channel.send({
                embeds: [msg.embeds[0].setDescription(eval(client.la[ls]["handlers"]["welcomejs"]["welcome"]["variable3"])).setImage("https://cdn.discordapp.com/attachments/807985610265460766/834519837782704138/success-3345091_1280.png")]
              }).catch(() => null);
              //try to delete the original message
              msg.delete().catch(() => null);
              //Do the WELCOME functions
              add_roles(member)
              message(member)
            } else {
              msg.edit({
                embeds: [],
                content: `**Failed the CAPTCHA!**`
              }).catch(() => null);
              try{ 
                //kick the member, but fetch the invites first if there is no valid invite
                if(member.guild.invites.cache.filter(i => i?.code && (i?.maxAge === 0 || i?.maxAge > 600)).size < 1)
                  await member.guild.invites.fetch().catch(() => null);
                //if there is a valid invite which lasts for at least 10 minutes or forever
                if(member.guild.invites.cache.filter(i => i?.code && (i?.maxAge === 0 || i?.maxAge > 600)).size > 0){
                  await member.send(`**OH NO - You failed the CAPTCHA!**\n> Here is an Invite Link in case u need one: https://discord.gg/${member.guild.invites.cache.filter(i => i?.code && i?.maxAge === 0).first().code}\n> :hammer: *I kicked you from the Server due to Security Reasons*`)
                  member.kick("FAILED THE CAPTCHA").catch(() => null);
                } else {
                  let channels = member.guild.channels.cache.filter(ch => ch.permissionsFor(member.guild.me).has(Permissions.FLAGS.CREATE_INSTANT_INVITE));
                  if(channels.size > 0) {
                    member.guild.invites.create(channels.first().id).create().then(async invite => {
                      await member.send(`**OH NO - You failed the CAPTCHA!**\n> Here is an Invite Link in case u need one: https://discord.gg/${invite.code}\n> :hammer: *I kicked you from the Server due to Security Reasons*`)
                      member.kick("FAILED THE CAPTCHA").catch(() => null);
                    }).catch(async e => {
                      await member.user.send(`**OH NO - You failed the CAPTCHA!**\n> :hammer: *I kicked you from the Server due to Security Reasons*`).catch(() => null)
                      member.kick("FAILED THE CAPTCHA").catch(() => null);
                    })
                  }
                }
              }catch (E){
                member.kick("FAILED THE CAPTCHA").catch(() => null);
              }
            }
          }).catch(async ()=>{
            msg.edit({
              embeds: [],
              content: `**Failed the CAPTCHA!**`
            }).catch(() => null);
            try{ 
              //kick the member, but fetch the invites first if there is no valid invite
              if(member.guild.invites.cache.filter(i => i?.code && (i?.maxAge === 0 || i?.maxAge > 600)).size < 1)
                await member.guild.invites.fetch().catch(() => null);
              //if there is a valid invite which lasts for at least 10 minutes or forever
              if(member.guild.invites.cache.filter(i => i?.code && (i?.maxAge === 0 || i?.maxAge > 600)).size > 0){
                await member.send(`**OH NO - You failed the CAPTCHA!**\n> Here is an Invite Link in case u need one: https://discord.gg/${member.guild.invites.cache.filter(i => i?.code && i?.maxAge === 0).first().code}\n> :hammer: *I kicked you from the Server due to Security Reasons*`)
                member.kick("FAILED THE CAPTCHA").catch(() => null);
              } else {
                let channels = member.guild.channels.cache.filter(ch => ch.permissionsFor(member.guild.me).has(Permissions.FLAGS.CREATE_INSTANT_INVITE));
                if(channels.size > 0) {
                  member.guild.invites.create(channels.first().id).create().then(async invite => {
                    await member.send(`**OH NO - You failed the CAPTCHA!**\n> Here is an Invite Link in case u need one: https://discord.gg/${invite.code}\n> :hammer: *I kicked you from the Server due to Security Reasons*`)
                    member.kick("FAILED THE CAPTCHA").catch(() => null);
                  }).catch(async e => {
                    await member.user.send(`**OH NO - You failed the CAPTCHA!**\n> :hammer: *I kicked you from the Server due to Security Reasons*`).catch(() => null)
                    member.kick("FAILED THE CAPTCHA").catch(() => null);
                  })
                }
              }
            }catch (E){
              member.kick("FAILED THE CAPTCHA").catch(() => null);
            }
          })
        }).catch(e => {
          member.guild.channels.create(`verify-${member.user.username}`.substring(0, 32), {
            type: "GUILD_TEXT",
            topic: "PLEASE SEND THE CAPTCHA CODE IN THE CHAT!",
            permissionOverwrites: [{
                id: member.user.id,
                allow: ["VIEW_CHANNEL", "SEND_MESSAGES"]
              },
              {
                id: client.user.id,
                allow: ["VIEW_CHANNEL", "EMBED_LINKS", "ATTACH_FILES", "SEND_MESSAGES"]
              },
              {
                id: member.guild.id,
                deny: ["VIEW_CHANNEL"]
              }
            ]
          }).then(ch => {
            try{
              if(ch.permissionsFor(ch.guild.me).has(Permissions.FLAGS.SEND_MESSAGES)){
                if(ch.permissionsFor(ch.guild.me).has(Permissions.FLAGS.EMBED_LINKS)){
                  ch.send({
                    content: `<@${member.user.id}>`,
                    embeds: [captchaembed], 
                    files: [attachment]
                  }).then(msg => {
                    msg.channel.awaitMessages({filter: m => m.author.id === member.user.id, 
                      max: 1,
                      time: 60000,
                      errors: ["time"]
                    }).then(async collected => {
                      if (collected.first().content.trim().toLowerCase() == captcha.text.toLowerCase()) {
                        //remove the role again
                        member.roles.remove(mutedrole.id).catch(e => console.error(e))
                        //Send the message to success
                        ch.delete().catch(() => null);
                        //Do the WELCOME functions
                        add_roles(member)
                        message(member)
                      } else {
                        msg.edit({
                          embeds: [],
                          content: `**Failed the CAPTCHA!**`
                        }).catch(() => null);
                        try{ 
                          //kick the member, but fetch the invites first if there is no valid invite
                          if(member.guild.invites.cache.filter(i => i?.code && (i?.maxAge === 0 || i?.maxAge > 600)).size < 1)
                            await member.guild.invites.fetch().catch(() => null);
                          //if there is a valid invite which lasts for at least 10 minutes or forever
                          if(member.guild.invites.cache.filter(i => i?.code && (i?.maxAge === 0 || i?.maxAge > 600)).size > 0){
                            await ch.send(`**OH NO - You failed the CAPTCHA!**\n> Here is an Invite Link in case u need one: https://discord.gg/${member.guild.invites.cache.filter(i => i?.code && i?.maxAge === 0).first().code}\n> :hammer: *I will kick you in 2 Seconds from the Server due to Security Reasons*`)
                            await delay(2000)
                            member.kick("FAILED THE CAPTCHA").catch(() => null);
                            ch.delete(() => {});
                          } else {
                            let channels = member.guild.channels.cache.filter(ch => ch.permissionsFor(member.guild.me).has(Permissions.FLAGS.CREATE_INSTANT_INVITE));
                            if(channels.size > 0) {
                              member.guild.invites.create(channels.first().id).create().then(async invite => {
                                await ch.send(`**OH NO - You failed the CAPTCHA!**\n> Here is an Invite Link in case u need one: https://discord.gg/${invite.code}\n> :hammer: *I will kick you in 2 Seconds from the Server due to Security Reasons*`)
                                await delay(2000)
                                member.kick("FAILED THE CAPTCHA").catch(() => null);
                                ch.delete(() => {});
                              }).catch(async e => {
                                await ch.user.send(`**OH NO - You failed the CAPTCHA!**\n> :hammer: *I will kick you in 2 Seconds from the Server due to Security Reasons*`).catch(() => null)
                                await delay(2000)
                                member.kick("FAILED THE CAPTCHA").catch(() => null);
                                ch.delete(() => {});
                              })
                            }
                          }
                        }catch (E){
                          member.kick("FAILED THE CAPTCHA").catch(() => null);
                        }
                      }
                    }).catch(async () => {
                      msg.edit({
                        embeds: [],
                        content: `**Failed the CAPTCHA!**`
                      }).catch(() => null);
                      try{ 
                        //kick the member, but fetch the invites first if there is no valid invite
                        if(member.guild.invites.cache.filter(i => i?.code && (i?.maxAge === 0 || i?.maxAge > 600)).size < 1)
                          await member.guild.invites.fetch().catch(() => null);
                        //if there is a valid invite which lasts for at least 10 minutes or forever
                        if(member.guild.invites.cache.filter(i => i?.code && (i?.maxAge === 0 || i?.maxAge > 600)).size > 0){
                          await ch.send(`**OH NO - You failed the CAPTCHA!**\n> Here is an Invite Link in case u need one: https://discord.gg/${member.guild.invites.cache.filter(i => i?.code && i?.maxAge === 0).first().code}\n> :hammer: *I kicked you from the Server due to Security Reasons*`)
                          await delay(2000)
                          member.kick("FAILED THE CAPTCHA").catch(() => null);
                          ch.delete(() => {});
                        } else {
                          let channels = member.guild.channels.cache.filter(ch => ch.permissionsFor(member.guild.me).has(Permissions.FLAGS.CREATE_INSTANT_INVITE));
                          if(channels.size > 0) {
                            member.guild.invites.create(channels.first().id).create().then(async invite => {
                              await ch.send(`**OH NO - You failed the CAPTCHA!**\n> Here is an Invite Link in case u need one: https://discord.gg/${invite.code}\n> :hammer: *I kicked you from the Server due to Security Reasons*`)
                              await delay(2000)
                              member.kick("FAILED THE CAPTCHA").catch(() => null);
                              ch.delete(() => {});
                            }).catch(async e => {
                              await ch.user.send(`**OH NO - You failed the CAPTCHA!**\n> :hammer: *I kicked you from the Server due to Security Reasons*`).catch(() => null)
                              await delay(2000)
                              member.kick("FAILED THE CAPTCHA").catch(() => null);
                              ch.delete(() => {});
                            })
                          }
                        }
                      }catch (E){
                        member.kick("FAILED THE CAPTCHA").catch(() => null);
                      }
                    })
                  }).catch(() => {
                    member.guild.fetchOwner().then(owner => {
                      owner.send(`:warning: **I can't create Channels_with_SEND_MESSAGES_PERMISSIONS for Captcha User, please give me PERMISSIONS for it asap!**`).catch(() => null);
                    }).catch(() => null);
                    member.kick().catch(() => null);
                  })
                } else {
                  ch.send({
                    content: `<@${member.user.id}>\n${captchaembed.description}`.substring(0, 2000), files: [attachment]
                  }).then(msg => {
                    msg.channel.awaitMessages({filter: m => m.author.id === member.user.id, 
                      max: 1,
                      time: 60000,
                      errors: ["time"]
                    }).then(async collected => {
                      if (collected.first().content.trim().toLowerCase() == captcha.text.toLowerCase()) {
                        //remove the role again
                        member.roles.remove(mutedrole.id).catch(e => console.error(e))
                        //Send the message to success
                        ch.delete().catch(() => null);
                        //Do the WELCOME functions
                        add_roles(member)
                        message(member)
                      } else {
                        msg.edit({
                          embeds: [],
                          content: `**Failed the CAPTCHA!**`
                        }).catch(() => null);
                        try{ 
                          //kick the member, but fetch the invites first if there is no valid invite
                          if(member.guild.invites.cache.filter(i => i?.code && (i?.maxAge === 0 || i?.maxAge > 600)).size < 1)
                            await member.guild.invites.fetch().catch(() => null);
                          //if there is a valid invite which lasts for at least 10 minutes or forever
                          if(member.guild.invites.cache.filter(i => i?.code && (i?.maxAge === 0 || i?.maxAge > 600)).size > 0){
                            await ch.send(`**OH NO - You failed the CAPTCHA!**\n> Here is an Invite Link in case u need one: https://discord.gg/${member.guild.invites.cache.filter(i => i?.code && i?.maxAge === 0).first().code}\n> :hammer: *I kicked you from the Server due to Security Reasons*`)
                            await delay(2000)
                            member.kick("FAILED THE CAPTCHA").catch(() => null);
                            ch.delete(() => {});
                          } else {
                            let channels = member.guild.channels.cache.filter(ch => ch.permissionsFor(member.guild.me).has(Permissions.FLAGS.CREATE_INSTANT_INVITE));
                            if(channels.size > 0) {
                              member.guild.invites.create(channels.first().id).create().then(async invite => {
                                await ch.send(`**OH NO - You failed the CAPTCHA!**\n> Here is an Invite Link in case u need one: https://discord.gg/${invite.code}\n> :hammer: *I kicked you from the Server due to Security Reasons*`)
                                await delay(2000)
                                member.kick("FAILED THE CAPTCHA").catch(() => null);
                                ch.delete(() => {});
                              }).catch(async e => {
                                await ch.user.send(`**OH NO - You failed the CAPTCHA!**\n> :hammer: *I kicked you from the Server due to Security Reasons*`).catch(() => null)
                                await delay(2000)
                                member.kick("FAILED THE CAPTCHA").catch(() => null);
                                ch.delete(() => {});
                              })
                            }
                          }
                        }catch (E){
                          member.kick("FAILED THE CAPTCHA").catch(() => null);
                        }
                      }
                    }).catch(async () => {
                      msg.edit({
                        embeds: [],
                        content: `**Failed the CAPTCHA!**`
                      }).catch(() => null);
                      try{ 
                        //kick the member, but fetch the invites first if there is no valid invite
                        if(member.guild.invites.cache.filter(i => i?.code && (i?.maxAge === 0 || i?.maxAge > 600)).size < 1)
                          await member.guild.invites.fetch().catch(() => null);
                        //if there is a valid invite which lasts for at least 10 minutes or forever
                        if(member.guild.invites.cache.filter(i => i?.code && (i?.maxAge === 0 || i?.maxAge > 600)).size > 0){
                          await ch.send(`**OH NO - You failed the CAPTCHA!**\n> Here is an Invite Link in case u need one: https://discord.gg/${member.guild.invites.cache.filter(i => i?.code && i?.maxAge === 0).first().code}\n> :hammer: *I kicked you from the Server due to Security Reasons*`)
                          await delay(2000)
                          member.kick("FAILED THE CAPTCHA").catch(() => null);
                          ch.delete(() => {});
                        } else {
                          let channels = member.guild.channels.cache.filter(ch => ch.permissionsFor(member.guild.me).has(Permissions.FLAGS.CREATE_INSTANT_INVITE));
                          if(channels.size > 0) {
                            member.guild.invites.create(channels.first().id).create().then(async invite => {
                              await ch.send(`**OH NO - You failed the CAPTCHA!**\n> Here is an Invite Link in case u need one: https://discord.gg/${invite.code}\n> :hammer: *I kicked you from the Server due to Security Reasons*`)
                              await delay(2000)
                              member.kick("FAILED THE CAPTCHA").catch(() => null);
                              ch.delete(() => {});
                            }).catch(async e => {
                              await ch.user.send(`**OH NO - You failed the CAPTCHA!**\n> :hammer: *I kicked you from the Server due to Security Reasons*`).catch(() => null)
                              await delay(2000)
                              member.kick("FAILED THE CAPTCHA").catch(() => null);
                              ch.delete(() => {});
                            })
                          }
                        }
                      }catch (E){
                        member.kick("FAILED THE CAPTCHA").catch(() => null);
                      }
                    })
                  }).catch(() => null)
                }
              } else {
                member.guild.fetchOwner().then(owner => {
                  owner.send(`:warning: **I can't create Channels_with_SEND_MESSAGES_PERMISSIONS for Captcha User, please give me PERMISSIONS for it asap!**`).catch(() => null);
                }).catch(() => null);
                member.kick().catch(() => null);
              }

            }catch(e){
              console.error(e);
              ch.delete().catch(() => null)
              member.kick().catch(() => null);
            }
          }).catch(e => {
            member.kick().catch(() => null);
            member.guild.fetchOwner().then(owner => {
              owner.send(`:warning: **I can't create Channels for Captcha User, please give me PERMISSIONS for it asap!**`).catch(() => null);
            }).catch(() => null);
          })
        })
      } else {
        add_roles(member)
        message(member)
      }
    }
    async function message(member) {
      let welcome = theSettings.welcome
      if(welcome && welcome.secondchannel !== "nochannel"){
        let themessage = String(welcome.secondmsg);
        if(!themessage || themessage.length == 0) themessage = ":wave: {user} **Welcome to our Server!** :v:";
        themessage = themessage.replace("{user}", `${member.user}`).replace("{username}", `${member.user.username}`).replace("{usertag}", `${member.user.tag}`)
        let channel = member.guild.channels.cache.get(welcome.secondchannel);
        if(!channel){
          try{
            client.channels.fetch(welcome.secondchannel).then(ch => {
              ch.send({content: themessage}).catch(() => null);
            }).catch(() => null);
          }catch (e){
            console.error(e)
          }
        } else {
          if(channel.permissionsFor(channel.guild.me).has(Permissions.FLAGS.SEND_MESSAGES)){
            channel.send({content: themessage}).catch(() => null);
          }
        }
      }

      if (welcome && welcome.channel !== "nochannel") {
        if (welcome.image) {
          if (welcome.dm) {
            if (welcome.customdm === "no") dm_msg_autoimg(member);
            else dm_msg_withimg(member);
          }

          if (welcome.custom === "no") msg_autoimg(member);
          else msg_withimg(member);
        } else {

          if (welcome.dm) {
            dm_msg_withoutimg(member);
          }

          msg_withoutimg(member)
        }
      }


      async function msg_withoutimg(member) {
        let welcomechannel = theSettings.welcome.channel;
        if (!welcomechannel) return;
        let channel = await client.channels.fetch(welcomechannel).catch(() => null)
        if (!channel) return;

        //define the welcome embed
        const welcomeembed = new MessageEmbed()
          .setColor(es.color).setThumbnail(es.thumb ? es.footericon && (es.footericon.includes("http://") || es.footericon.includes("https://")) ? es.footericon : client.user.displayAvatarURL() : null)
          .setTimestamp()
          .setFooter(client.getFooter(`ID: ${member.user.id}`, `${member.user.displayAvatarURL({ dynamic: true })}`))
          .setTitle(eval(client.la[ls]["handlers"]["welcomejs"]["welcome"]["variable7"]))
          .setDescription(theSettings.welcome.msg.replace("{user}", `${member.user}`).replace("{username}", `${member.user.username}`).replace("{usertag}", `${member.user.tag}`))
          .addField(eval(client.la[ls]["handlers"]["welcomejs"]["welcome"]["variablex_8"]), eval(client.la[ls]["handlers"]["welcomejs"]["welcome"]["variable8"]))
        
          //send the welcome embed to there
          if(channel.permissionsFor(channel.guild.me).has(Permissions.FLAGS.SEND_MESSAGES)){
            if(channel.permissionsFor(channel.guild.me).has(Permissions.FLAGS.EMBED_LINKS)){
              channel.send({
                content: `<@${member.user.id}>`,
                embeds: [welcomeembed]
              }).catch(() => null);
            } else {
              channel.send({
                content: `<@${member.user.id}>\n${welcomeembed.description}`.substring(0, 2000),
              }).catch(() => null);
            }
          }
        
      }
      async function dm_msg_withoutimg(member) {
        //define the welcome embed
        const welcomeembed = new MessageEmbed()
          .setColor(es.color).setThumbnail(es.thumb ? es.footericon && (es.footericon.includes("http://") || es.footericon.includes("https://")) ? es.footericon : client.user.displayAvatarURL() : null)
          .setTimestamp()
          .setFooter(client.getFooter(`ID: ${member.user.id}`, `${member.user.displayAvatarURL({ dynamic: true })}`))
          .setTitle(eval(client.la[ls]["handlers"]["welcomejs"]["welcome"]["variable9"]))
          .setDescription(theSettings.welcome.dm_msg.replace("{user}", `${member.user}`).replace("{username}", `${member.user.username}`).replace("{usertag}", `${member.user.tag}`))
          if(theSettings.welcome.invitedm) welcomeembed.addField("\u200b", `${invitemessage}`)
          //send the welcome embed to there
        member.user.send({
          content: `<@${member.user.id}>`,
          embeds: [welcomeembed]
        }).catch(() => null);
      }


      async function dm_msg_withimg(member) {
        //define the welcome embed
        const welcomeembed = new MessageEmbed()
          .setColor(es.color).setThumbnail(es.thumb ? es.footericon && (es.footericon.includes("http://") || es.footericon.includes("https://")) ? es.footericon : client.user.displayAvatarURL() : null)
          .setTimestamp()
          .setFooter(client.getFooter(`ID: ${member.user.id}`, `${member.user.displayAvatarURL({ dynamic: true })}`))
          .setTitle(eval(client.la[ls]["handlers"]["welcomejs"]["welcome"]["variable10"]))
          .setDescription(theSettings.welcome.dm_msg.replace("{user}", `${member.user}`).replace("{username}", `${member.user.username}`).replace("{usertag}", `${member.user.tag}`))
          .setImage(theSettings.welcome.customdm)
          if(theSettings.welcome.invitedm) welcomeembed.addField("\u200b", `${invitemessage}`)
          //send the welcome embed to there
        member.user.send({
          content: `<@${member.user.id}>`,
          embeds: [welcomeembed]
        }).catch(() => null);
      }
      async function msg_withimg(member) {
        let welcomechannel = theSettings.welcome.channel;
        if (!welcomechannel) return;
        let channel = await client.channels.fetch(welcomechannel).catch(() => null)
        if (!channel) return;

        //define the welcome embed
        const welcomeembed = new MessageEmbed()
          .setColor(es.color).setThumbnail(es.thumb ? es.footericon && (es.footericon.includes("http://") || es.footericon.includes("https://")) ? es.footericon : client.user.displayAvatarURL() : null)
          .setTimestamp()
          .setFooter(client.getFooter(`ID: ${member.user.id}`, `${member.user.displayAvatarURL({ dynamic: true })}`))
          .setTitle(eval(client.la[ls]["handlers"]["welcomejs"]["welcome"]["variable11"]))
          .setDescription(theSettings.welcome.msg.replace("{user}", `${member.user}`).replace("{username}", `${member.user.username}`).replace("{usertag}", `${member.user.tag}`))
          .setImage(theSettings.welcome.custom)
          if(theSettings.welcome.invite) welcomeembed.addField("\u200b", `${invitemessage}`)
          //send the welcome embed to there
        if(channel.permissionsFor(channel.guild.me).has(Permissions.FLAGS.SEND_MESSAGES)){
          if(channel.permissionsFor(channel.guild.me).has(Permissions.FLAGS.EMBED_LINKS)){
            channel.send({
              content: `<@${member.user.id}>`,
              embeds: [welcomeembed]
            }).catch(() => null);
          } else {
            channel.send({
              content: `<@${member.user.id}>\n${welcomeembed.description}`.substring(0, 2000),
            }).catch(() => null);
          }
        }
      }

      async function dm_msg_autoimg(member) {
        try {
          //define the welcome embed
          const welcomeembed = new MessageEmbed()
            .setColor(es.color).setThumbnail(es.thumb ? es.footericon && (es.footericon.includes("http://") || es.footericon.includes("https://")) ? es.footericon : client.user.displayAvatarURL() : null)
            .setTimestamp()
            .setFooter(client.getFooter(`ID: ${member.user.id}`, `${member.user.displayAvatarURL({ dynamic: true })}`))
            .setTitle(eval(client.la[ls]["handlers"]["welcomejs"]["welcome"]["variable12"]))
            .setDescription(theSettings.welcome.dm_msg.replace("{user}", `${member.user}`).replace("{username}", `${member.user.username}`).replace("{usertag}", `${member.user.tag}`))
          if(theSettings.welcome.invitedm) welcomeembed.addField("\u200b", `${invitemessage}`)
          
          
          // Get the buffer from the api / Handler File
          const { buffer } = await MilratoCanvasApi.getWelcomeDm({
            welcomeSettings: theSettings.welcome,
            guildIconUrl: member.guild.iconURL({ dynamic: false, format: "png", size: 4096 }),
            memberCount: member.guild.memberCount,
            discriminator: member.user.discriminator,
            username: member.user.username,
            guildName: member.guild.name,
            avatarUrl: member.user.displayAvatarURL({ dynamic: false, format: "png", size: 4096 })
          });

          //get it as a discord attachment
          const attachment = new MessageAttachment(buffer, `welcome-image.png`);
          //send the welcome embed to there
          member.user.send({
            content: `<@${member.user.id}>`,
            embeds: [welcomeembed.setImage(`attachment://welcome-image.png`) ],
            files: [attachment]
          }).catch(() => null);
          //member roles add on welcome every single role
        } catch {}
      }
      async function msg_autoimg(member) {
        try {
          let welcomechannel = theSettings.welcome.channel;
          if (!welcomechannel) return
          let channel = await client.channels.fetch(welcomechannel).catch(() => null)
          if (!channel) return 
          //define the welcome embed
          const welcomeembed = new MessageEmbed()
            .setColor(es.color).setThumbnail(es.thumb ? es.footericon && (es.footericon.includes("http://") || es.footericon.includes("https://")) ? es.footericon : client.user.displayAvatarURL() : null)
            .setTimestamp()
            .setFooter(client.getFooter(`ID: ${member.user.id}`, `${member.user.displayAvatarURL({ dynamic: true })}`))
            .setTitle(eval(client.la[ls]["handlers"]["welcomejs"]["welcome"]["variable13"]))
            .setDescription(theSettings.welcome.msg.replace("{user}", `${member.user}`).replace("{username}", `${member.user.username}`).replace("{usertag}", `${member.user.tag}`))
            if(theSettings.welcome.invite) welcomeembed.addField("\u200b", `${invitemessage}`)
            try {

              
            // Get the buffer from the api / Handler File
            const { buffer } = await MilratoCanvasApi.getWelcomeChannel({
              welcomeSettings: theSettings.welcome,
              guildIconUrl: member.guild.iconURL({ dynamic: false, format: "png", size: 4096 }),
              memberCount: member.guild.memberCount,
              discriminator: member.user.discriminator,
              username: member.user.username,
              guildName: member.guild.name,
              avatarUrl: member.user.displayAvatarURL({ dynamic: false, format: "png", size: 4096 })
            });

            //get it as a discord attachment
            const attachment = new MessageAttachment(buffer, `welcome-image.png`);
            //send the welcome embed to there
            if(channel.permissionsFor(channel.guild.me).has(Permissions.FLAGS.SEND_MESSAGES)){
              if(channel.permissionsFor(channel.guild.me).has(Permissions.FLAGS.EMBED_LINKS) && channel.permissionsFor(channel.guild.me).has(Permissions.FLAGS.ATTACH_FILES)){
                channel.send({
                  content: `<@${member.user.id}>`,
                  embeds: [welcomeembed.setImage(`attachment://welcome-image.png`)],
                  files: [attachment]
                }).catch(() => null);
              } else if(channel.permissionsFor(channel.guild.me).has(Permissions.FLAGS.ATTACH_FILES)){
                channel.send({
                  content: `<@${member.user.id}>\n${welcomeembed.description}`.substring(0, 2000),
                  files: [attachment]
                }).catch(() => null);
              } else {
                channel.send({
                  content: `<@${member.user.id}>\n${welcomeembed.description}`.substring(0, 2000),
                  files: [attachment]
                }).catch(() => null);
              }
            }
          } catch (e) {
            console.error(e);
          }
        } catch (e) {
          console.error(e)
        }
      }
    }

    function add_roles(member) {
      let roles = theSettings.welcome.roles
      if (roles && roles.length > 0) {
        for (const role of roles) {
          try {
            let R = member.guild.roles.cache.get(role);
            if(R) member.roles.add(R.id).catch(() => null);
          } catch (e){ }
        }
      }
    }
  })
  

  /**
   * ANTI-NEW-ACCOUNT Detector
   */
  client.on("guildMemberAdd", async member => {
    if(!member.guild || member.user.bot) return;
    await dbEnsure(await client.settings, member.guild.id, {
      antinewaccount: {
        enabled: false,
        delay: ms("2 days"),
        action: "kick", // kick / ban
        extra_message: "Please do not join back, unless you meet the requirements!"
      } 
    });
    //Return if account system is disabled
    let newAccount = await client.settings.get(member.guild.id);
    if(!newAccount || !newAccount.antinewaccount || !newAccount.antinewaccount.enabled) return; 
    //get the ms time of the account creationj
    const createdAccount = new Date(member.user.createdAt).getTime(); 
    const newaccount_delay = newAccount.antinewaccount.delay;
    //return if account is old enough
    if(newaccount_delay < Date.now() - createdAccount) return;
    const extramessage = newAccount.antinewaccount.extra_message;
    const action = newAccount.antinewaccount.action;
    if(action == "ban") {
      await member.send({
        embeds: [
          new MessageEmbed()
          .setTitle(`You got banned from __${member.guild.name}__`)
          .setThumbnail(member.guild.iconURL({dynamic: true}))
          .setFooter(client.getFooter(`${member.guild.name} | ${member.guild.id}`, `${member.guild.iconURL({ dynamic: true })}`))
          .setDescription(`This is because your Account was Created ${duration(Date.now() - createdAccount).map(a => `\`${a}\``).join(", ")} ago, and the minimum Amount of Account-Age should be: ${duration(newaccount_delay).map(a => `\`${a}\``).join(", ")}`)
          .addField(`**Guild-Message:**`, `${extramessage && extramessage.length > 1 ? extramessage : "No Extra Message provided"}`.substring(0, 1024))
        ]
      }).catch(() => null);
      member.ban({reason: `Alt Account Detection | Account created ${duration(Date.now() - createdAccount).join(", ")} ago`})
    } else {
      await member.send({
        embeds: [
          new MessageEmbed()
          .setTitle(`You got kicked from __${member.guild.name}__`)
          .setThumbnail(member.guild.iconURL({dynamic: true}))
          .setFooter(client.getFooter(`${member.guild.name} | ${member.guild.id}`, `${member.guild.iconURL({ dynamic: true })}`))
          .setDescription(`This is because your Account was Created ${duration(Date.now() - createdAccount).map(a => `\`${a}\``).join(", ")} ago, and the minimum Amount of Account-Age should be: ${duration(newaccount_delay).map(a => `\`${a}\``).join(", ")}`)
          .addField(`**Guild-Message:**`, `${extramessage && extramessage.length > 1 ? extramessage : "No Extra Message provided"}`.substring(0, 1024))
        ]
      }).catch(() => null);
      member.kick({reason: `Alt Account Detection | Account created ${duration(Date.now() - createdAccount).join(", ")} ago`})
    }
  })


  /**
   * JOINLIST SYSTEM
   */
  client.on("guildMemberAdd", async member => {
    if(!member.guild || member.user.bot) return;
    await dbEnsure(client.settings, member.guild.id, {
      joinlist: {
        username_contain: [/*
          {
            data: "",
            action: "",
            time: TIMESTAMP,
            nickname: NICKNAME/{random}
          } 
        */],
        username_equal: [],
        userid: [],
        server_in_common: [],
        server_not_in_common: [],
        noavatar: []
      }
    });

    const joinlist = await client.settings.get(member.guild.id+ ".joinlist");
    if(!joinlist) return;
    let inthere = false;
    let notInthere = false;
    
    if(!member.user.avatarURL() && joinlist.noavatar.filter(d => d.data == "enable").length > 0) {
      const reason = '`User not having an Avatar (joinlist)`'
      const datas = joinlist.noavatar.filter(d => d.data == "enable");
      await handleDatas(datas, reason);
    }

    if(joinlist.username_contain.map(d => d.data).some(d => member.user.username.toLowerCase().includes(d.toLowerCase()))) {
      const reason = '`Username contains ${data.data} (joinlist)`'
      const datas = joinlist.username_contain.filter(d => member.user.username.toLowerCase().includes(d.data.toLowerCase()));
      await handleDatas(datas, reason);
    }

    if(joinlist.username_equal.map(d => d.data).some(d => d.toLowerCase() == member.user.username.toLowerCase())) {
      const reason = '`Username is equal to ${data.data} (joinlist)`'
      const datas = joinlist.username_equal.filter(d => d.data.toLowerCase() == member.user.username.toLowerCase());
      await handleDatas(datas, reason);
    }

    if(joinlist.userid.map(d => d.data).some(d => d == member.id)) {
      const reason = '`User ID is equal to ${data.data} (joinlist)`'
      const datas = joinlist.userid.filter(d => d.data == member.id);
      await handleDatas(datas, reason);
    }

    if(joinlist.server_in_common.map(d => d.data).length > 0) {
      const guilds = joinlist.server_in_common.map(d => d.data);
      for await (const guild of guilds) {
        const g = client.guilds.cache.get(guild);
        if(g) {
          let themember = g.members.cache.get(member.id) || await g.members.fetch(member.id).catch(() => null)
          if(themember) {
            inthere = g;
            break;
          }
        }
      }
      const reason = '`You are in the Guild ${inthere.name} (joinlist)`'
      const datas = joinlist.server_in_common.filter(d => d.data == inthere.id);
      await handleDatas(datas, reason, true);
    }

    if(joinlist.server_not_in_common.map(d => d.data).length > 0) {
      const guilds = joinlist.server_not_in_common.map(d => d.data);
      for await (const guild of guilds) {
        const g = client.guilds.cache.get(guild);
        if(g) {
          let themember = g.members.cache.get(member.id) || await g.members.fetch(member.id).catch(() => null)
          if(!themember) {
            notInthere = g;
            break;
          }
        }
      }
      const reason = '`You are not in the Guild ${notInthere.name} (joinlist)`'
      const datas = joinlist.server_not_in_common.filter(d => d.data == notInthere.id);
      await handleDatas(datas, reason);
    }

    function handleDatas(datas, reason = "No reason provided") {
      return new Promise(async (resolve, reject) => {
        if(datas.length > 0) {
          for await (const data of datas) {
            if(data.action == "kick") {
              if(member.kickable) {
                await member.send(`You got kicked from \`${member.guild.name}\` because:\n> ${eval(reason)}`).catch(() => null);
                await member.kick({reason: `${eval(reason)}`}).catch(console.warn)
              }
            } 
            if(data.action == "ban") {
              if(member.bannable) {
                await member.send(`You got banned from \`${member.guild.name}\` for ${data.days != 0 ? `${data.days} Days` : `ever`} because:\n> ${eval(reason)}`).catch(() => null);
                await member.ban({reason: `${eval(reason)}`, days: data.days }).catch(console.warn)
              }
            } 
            if(data.time && data.time > 0 && data.action == "timeout") {
              if(member.manageable) {
                await member.send(`You got timeouted until <t:${Math.floor((Date.now() + data.time) / 1000)}:F> from \`${member.guild.name}\` because:\n> ${eval(reason)}`).catch(() => null);
                await member.timeout(data.time, `${eval(reason)}`).catch(console.warn)
              }
            } 
            if(data.nickname && data.nickname.length > 0 && data.nickname.length < 32 && data.action == "setnickname") {
              if(member.manageable) {
                await member.setNickname(data.nickname, `${eval(reason)}`).catch(console.warn)
              }
            }
          }
          return resolve(true);
        } else {
          return resolve(true);
        }
      })
    }
  })


  /**
   * INCREASE THE MESSAGECOUNTER 
   */
  client.on("messageCreate", async message => {
    if(message.guild && message.author?.id){
      if(!await client.invitesdb.get(message.guild.id + message.author?.id)) {
        await dbEnsure(client.invitesdb, `${message.guild.id + message.author?.id}`, { messagesCount: 0 }).catch(console.warn);
      }
      await client.invitesdb.add(`${message.guild.id + message.author?.id}.messagesCount`, 1).catch(console.warn);
    }
  })

  function inviteToJson (invite) {
    return {
        guildId: invite.guild?.id,
        code: invite.code,
        url: invite.url,
        uses: invite.uses,
        maxUses: invite.maxUses,
        maxAge: invite.maxAge,
        createdTimestamp: invite.createdTimestamp,
        deletedTimestamp: invite.deletedTimestamp,
        inviter: invite.inviter,
    };
  };

  function generateInvitesCache (invitesCache) {
    const cacheCollection = new Collection();
    invitesCache.forEach((invite) => {
        cacheCollection.set(invite.code, inviteToJson(invite));
    });
    return cacheCollection;
  };

  function isEqual (value, other) {
    const type = Object.prototype.toString.call(value);
    if (type !== Object.prototype.toString.call(other)) return false;
    if (["[object Array]", "[object Object]"].indexOf(type) < 0) return false;
    const valueLen = type === "[object Array]" ? value.length : Object.keys(value).length;
    const otherLen = type === "[object Array]" ? other.length : Object.keys(other).length;
    if (valueLen !== otherLen) return false;
    const compare = (item1, item2) => {
        const itemType = Object.prototype.toString.call(item1);
        if (["[object Array]", "[object Object]"].indexOf(itemType) >= 0) {
            if (!isEqual(item1, item2)) return false;
        }
        else {
            if (itemType !== Object.prototype.toString.call(item2)) return false;
            if (itemType === "[object Function]") {
                if (item1.toString() !== item2.toString()) return false;
            } else {
                if (item1 !== item2) return false;
            }
        }
    };
    if (type === "[object Array]") {
        for (var i = 0; i < valueLen; i++) {
            if (compare(value[i], other[i]) === false) return false;
        }
    } else {
        for (var key in value) {
            if (Object.prototype.hasOwnProperty.call(value, key)) {
                if (compare(value[key], other[key]) === false) return false;
            }
        }
    }
    return true;
  };

  async function EnsureInviteDB(guild, user) {
    const res = await dbEnsure(client.invitesdb, guild.id + user.id, {
      /* REQUIRED */
      id: user.id, // Discord ID of the user
      guildId: guild.id,
      /* STATS */
      fake: 0,
      leaves: 0,
      invites: 0,
      /* INVITES DATA */
      invited: [],
      left: [],
      /* INVITER */
      joinData: {
        type: "unknown",
        invite: null
      }, // { type: "normal" || "unknown" || "vanity", invite: inviteData || null }
      messagesCount: 0,
      /* BOT */
      bot: user.bot
    });

    if(res && res.changed) {
      DbAllCache.set(guild.id, false);
      DbAllCache.delete(guild.id);
    }

    return true;
  };

  function compareOldWithNew(oldInvites, currentInvites) {
    const invitesUsed = [];
    currentInvites.forEach((invite) => {
      if(invite.uses !== 0 && oldInvites.get(invite.code) && oldInvites.get(invite.code)?.uses < invite?.uses) {
        invitesUsed.push(invite);
      }
    });
    if(invitesUsed.length < 1) {
      oldInvites.sort((a, b) => (a.deletedTimestamp && b.deletedTimestamp) ? b.deletedTimestamp -a.deletedTimestamp : 0).forEach((invite) => {
        if(!currentInvites.get(invite.code) && invite.maxUses > 0 && invite.uses == (invite.maxUses - 1)) {
          invitesUsed.push(invite);
        } 
      })
    }
    return invitesUsed;
  };

  function getDefaultWelcomeData() {
    return {
      welcome: {
        captcha: false,
        roles: [],
        channel: "nochannel",
        secondchannel: "nochannel",
        secondmsg: ":wave: {user} **Welcome to our Server!** :v:",
        image: true,
        custom: "no",
        background: "transparent",
        frame: true,
        framecolor: "white",
        pb: true,
        invite: true,
        discriminator: true,
        membercount: true,
        servername: true,
        msg: "{user} Welcome to this Server",
        dm: false,
        imagedm: false,
        customdm: "no",
        backgrounddm: "transparent",
        framedm: true,
        framecolordm: "white",
        pbdm: true,
        invitedm: true,
        discriminatordm: true,
        membercountdm: true,
        servernamedm: true,
        dm_msg: "{user} Welcome to this Server"
      }
    }
  };
}