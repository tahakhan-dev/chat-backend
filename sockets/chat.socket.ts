import * as _ from "lodash";
import { v4 as uuidv4 } from 'uuid';
import { RedisService } from "../app/cache/redis.service";
import { IMessage, Messages } from "../app/http/services/kafka.service";
import { ResponseSockets } from "./response.socket";

class Chat extends Messages {
    private _consumer
    private _producer
    protected response: ResponseSockets
    constructor(consumer, producer) {
        super()
        this._consumer = consumer
        this._producer = producer

        this._producer.connect()
    }

    async observer(topic: string, id: string) {
        await this._consumer.connect()
        await this._consumer.subscribe({
            topic: topic,
            fromBeginning: true
        })
        console.log("Consumer started for: ", topic, id)
        await this._consumer.run({
            eachMessage: async result => {

                // Check if message is stored in redis and remove if delivered | read state is received on pid message
                let data = JSON.parse(result.message.value.toString())
                RedisService.searchAndDeleteKeys(`${data.id}`)
                if (data.pid != null) {
                    RedisService.searchAndDeleteKeys(`${data.pid}`)
                }

                this.response.message("message", result.message.value.toString())
            }
        })
    }

    async publisher(topic: string, data: IMessage) {
        const result = await this._producer.send({
            topic: topic,
            messages: [{
                value: JSON.stringify(data),
                partition: 1
            }]
        })
        console.log(`Sent ${JSON.stringify(result)}`)
    }
}

export class ChatSockets extends Chat {
    private _socket
    constructor(socket, consumer, producer) {
        super(consumer, producer)

        this._socket = socket
        this.response = new ResponseSockets(this._socket)
    }

    get routes() {
        this.observer(this._socket['user'].profile.phoneNo, this._socket['user'].profile.userId)

        this._socket.on("group-message", async ({ gid, data }, callback) => {
            try {
                if (gid != null) {
                    let roomMembers = await this.getGroup(gid)
                    if (roomMembers == null) {
                        this.response.error("Group not found", null)
                    } else {
                        data = JSON.parse(data)
                        roomMembers = _.reject(roomMembers, x => data.from == x)
                        Promise.all(roomMembers.map(async x => {
                            let message = _.clone(data)
                            message['id'] = uuidv4();
                            message['to'] = x
                            message['createdAt'] = new Date().getTime() / 1000;

                            let presence = await this.checkPresence(message.to)

                            // Store message to store if user is not available
                            if (presence.presence != "ONLINE") {
                                //Store message for 30 days
                                console.log("Setting message to store", data.id)
                                RedisService.setData(message, `${message.id}|${message.to}|${message.from}|message`, 720 * 60 * 60 * 1000)
                            }

                            this.publisher(x, message)
                        })).then(() => {
                            callback();
                        })
                    }
                } else {
                    this.response.error("Group not found", null)
                }
            } catch (error) {
                this.response.error("There was error in your request", null)
            }
        })

        this._socket.on("message", async ({ topic, data }, callback) => {
            try {
                data = JSON.parse(data)

                data['id'] = uuidv4();
                data['createdAt'] = new Date().getTime() / 1000;

                let presence = await this.checkPresence(data.to)

                // Store message to store if user is not available
                if (presence.presence != "ONLINE") {
                    //Store message for 30 days
                    console.log("Setting message to store", data.id)
                    RedisService.setData(data, `${data.id}|${data.to}|${data.from}|message`, 720 * 60 * 60 * 1000)
                }

                this.publisher(topic, data)
                callback();

            } catch (error) {
                this.response.error("There was error in your request", null)
            }
        })

        this._socket.on("group-presence", async (gid, callback) => {
            try {
                if (gid != null) {
                    let roomMembers = await this.getGroup(gid)
                    if (roomMembers == null) {
                        this.response.error("Group not found", null)
                    } else {
                        Promise.all(roomMembers.map(async x => {
                            let phone = Number(x)
                            // This is used to get the presence of other users 
                            let users = await RedisService.searchData(`${phone}|*|user`)
                            let user;
                            if (users.length > 0) {
                                user = _.clone(users[0])
                                let presence = await this.checkPresence(phone)
                                if (presence == null) {
                                    // This would happen when you're developing or the user is very new to the system and does not have an encryption key
                                    return null;
                                } else {
                                    user['presence'] = presence
                                    return user;
                                }
                            } else {
                                user = await this.getUser(phone)
                                if (user == null) {
                                    return null;

                                } else {
                                    let presence = await this.checkPresence(phone)
                                    if (presence == null) {
                                        // This would happen when you're developing or the user is very new to the system and does not have an encryption key
                                        return null;
                                    } else {
                                        user['presence'] = presence
                                        return user;
                                    }
                                }
                            }
                        })).then(users => {
                            users = _.reject(users, k => k == null)
                            callback(users)
                        })
                    }
                } else {
                    this.response.error("Group not found", null)
                }
            } catch (error) {
                this.response.error("There was error in your request", null)
            }
        })

        this._socket.on("presence", async (phone, callback) => {
            try {
                // This is used to get the presence of other users 
                let users = await RedisService.searchData(`${phone}|*|user`)
                let user;
                if (users.length > 0) {
                    console.log("SENDING FROM REDIS")
                    user = _.clone(users[0])
                    let presence = await this.checkPresence(phone)
                    if (presence == null) {
                        // This would happen when you're developing or the user is very new to the system and does not have an encryption key
                        this.response.error("There was error in your request", null)
                    } else {
                        user['presence'] = presence
                        callback(user);
                    }
                } else {
                    user = await this.getUser(phone)
                    if (user == null) {
                        this.response.error("User not found", null)
                    } else {
                        let presence = await this.checkPresence(phone)
                        if (presence == null) {
                            // This would happen when you're developing or the user is very new to the system and does not have an encryption key
                            this.response.error("There was error in your request", null)
                        } else {
                            user['presence'] = presence
                            callback(user);
                        }
                    }
                }
            } catch (error) {
                this.response.error("There was error in your request", null)
            }
        })
        return this._socket
    }
}