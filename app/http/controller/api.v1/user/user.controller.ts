import * as _ from "lodash";
import fs from "fs";
import moment from "../../../../modules/moment";
import { UserService } from "../../../services/user.service";
import { Sender } from "../../../services/sender.service";
import { IUserEdit } from "../../../models/user.model";
import { Cloudinary, ICloudinaryUpload } from "../../../../constants/cloudinary";
import { ImageService } from "../../../services/image.service";
import { Request, Response } from "express"

export class User {
    async get(req: Request, res: Response) {
        try {
            const userService = new UserService();
            let limit = _.toInteger(req.query.limit);
            let page = _.toInteger(req.query.page);
            let { key, id } = req.query;
            if (id != null && id != "" && id != undefined) {
                // Searching user by ID
                let checkInMyList = _.indexOf(req['user'].data.blockedByMe, id)
                let checkInOthersList = _.indexOf(req['user'].data.blockedByOthers, id)
                if (checkInMyList == -1 || checkInOthersList == -1) {
                    // Found a blocked user
                    Sender.errorSend(res, { success: false, msg: "User not found", status: 400 })
                    return;
                } else {
                    let user = await userService.findOne({ id })
                    if (user == null) {
                        Sender.errorSend(res, { success: false, msg: "User not found", status: 400 })
                        return;
                    } else {
                        userService.redisUpdateUser(user);
                        Sender.send(res, {
                            success: true, data: user.profile, status: 200
                        })
                        return;
                    }
                }
            } else {
                let query = { blocked: false, role: "USER", profile: { approved: true } }
                if (key != null && key != "") {
                    let orQuery = [
                        { email: { contains: key, mode: "insensitive", } },
                        { profile: { firstName: { contains: key, mode: "insensitive", } } },
                        { profile: { lastName: { contains: key, mode: "insensitive", } } }
                    ]
                    query['OR'] = orQuery;
                }
                let { users, count } = await userService.findWithLimit(query, limit, page)
                let user_profiles = users.map(x => x.profile)
                user_profiles = _.filter(user_profiles, x => {
                    let checkInMyList = _.indexOf(req['user'].data.blockedByMe, x.userId)
                    let checkInOthersList = _.indexOf(req['user'].data.blockedByOthers, x.userId)
                    if (checkInMyList == -1 && checkInOthersList == -1) {
                        // Didn't find a blocked user
                        return x;
                    }
                })
                users.map(user => userService.redisUpdateUser(user))
                Sender.send(res, {
                    success: true,
                    data: user_profiles,
                    raw: "live",
                    page: page,
                    pages: Math.ceil(count / limit),
                    count,
                    status: 200
                });
            }
        } catch (error) {
            Sender.errorSend(res, { success: false, msg: error.message, status: 500 });
        }
    }

    async update(req: Request, res: Response) {
        try {
            const userService = new UserService();
            let update = req.body;
            if (req.body.birthday != null && req.body.birthday != "") {
                if (!moment(req.body.birthday).olderThan14()) {
                    Sender.errorSend(res, { success: false, msg: "You must be older than 14 years to use the app", status: 400 });
                    return;
                } else {
                    update['birthday'] = moment(req.body.birthday).format()
                }
            }
            update['city'] = update.city.toLowerCase();
            update['country'] = update.country.toLowerCase();
            update['birthYearVisibility'] = update.birthYearVisibility ? true : false;
            update['locationVisibility'] = update.locationVisibility ? true : false;
            update['locationRange'] = Number(update.locationRange);
            let user: IUserEdit = {
                profile: {
                    update
                }
            }
            let updatedUser = await userService.findOneAndUpdate({ id: req['user'].id }, user)
            if (req['user'].data.profile.approved == false && updatedUser.profile.firstName != null && updatedUser.profile.lastName != null && updatedUser.profile.about != null && updatedUser.profile.profileImage != null) {
                updatedUser = await userService.findOneAndUpdate({ id: req['user'].id }, { profile: { update: { approved: true } } })
                userService.redisUpdateUser(updatedUser) // this only works once because the profile is approved after registrations
            }
            if (req['user'].data.profile.approved) {
                userService.redisUpdateUser(updatedUser)
            }
            Sender.send(res, {
                status: 200, success: true, data: updatedUser, msg: "User updated successfully"
            });
        } catch (error) {
            Sender.errorSend(res, { success: false, msg: error.message, status: 500 });
        }
    }

    async uploader(req: Request, res: Response) {
        try {
            const imageService = new ImageService();
            let { files, alreadyUploaded } = req.body;
            const image: any = async (path, name) => { // MIN 
                return await Cloudinary.uploads(path, `${req['user'].id}/${name}`);
            }
            if (files != null && files.length != 0) {
                if (files.length > Math.abs(3 - alreadyUploaded)) {
                    Sender.errorSend(res, { success: false, status: 409, msg: `Your profile already has ${alreadyUploaded} images uploaded. Cannot upload more than ${Math.abs(3 - alreadyUploaded)} images on your profile` })
                    files.map(file => {
                        fs.unlink(file, () => { console.log(`Deleted ${file}`) });
                    })
                } else {
                    console.log("Starting upload")
                    let images: ICloudinaryUpload[] = await Promise.all(files.map(async file => {
                        let pathSplit = file.split('/')[2].split('.').slice(0, -1).join('.')
                        const imgURL = await image(file, pathSplit);
                        fs.unlink(file, () => { console.log(`Deleted ${file}`) });
                        return imgURL;
                    }))
                    let uploadImages = await imageService.create(images.map(i => { return { cloudinaryId: i.id, path: i.path, userId: req['user'].id } }))
                    Sender.send(res, { success: true, data: uploadImages, msg: "Images uploaded", status: 201 })
                }
            } else {
                Sender.errorSend(res, { success: false, status: 400, msg: "Files not found" })
            }

        } catch (error) {
            Sender.errorSend(res, { success: false, msg: error.message, status: 500 });
        }
    }

    async upload(req: Request, res: Response) {
        try {
            const imageService = new ImageService();
            let { files, position } = req.body;
            console.log(req.body)
            const image: any = async (path, name) => { // MIN 
                return await Cloudinary.uploads(path, `${req['user'].id}/${name}`);
            }
            if(files.length > 1)
                Sender.errorSend(res, { success: false, status: 400, msg: "Can't upload more than one file" })

            if (files != null && files.length != 0) {
                console.log("Starting upload")
                let images: ICloudinaryUpload[] = await Promise.all(files.map(async file => {
                    let pathSplit = file.split('/')[2].split('.').slice(0, -1).join('.')
                    const imgURL = await image(file, pathSplit);
                    fs.unlink(file, () => { console.log(`Deleted ${file}`) });
                    return imgURL;
                }))
                let imageOnPosition = await imageService.findOne({ userId: req['user'].id, position, type: "USER" })
                if (imageOnPosition) {
                    const imageRemove: any = async (path) => { // MINI Function 
                        return await Cloudinary.remove(path);
                    }
                    console.log(imageOnPosition)
                    await imageService.delete({ id: imageOnPosition.id })
                    await imageRemove(imageOnPosition.cloudinaryId);
                }
                let uploadImages = await imageService.create(images.map(i => { return { cloudinaryId: i.id, path: i.path, userId: req['user'].id, position } }))
                Sender.send(res, { success: true, data: uploadImages, msg: "Images uploaded", status: 201 })

            } else {
                Sender.errorSend(res, { success: false, status: 400, msg: "Files not found" })
            }

        } catch (error) {
            Sender.errorSend(res, { success: false, msg: error.message, status: 500 });
        }
    }

    async getImages(req: Request, res: Response) {
        try {
            console.log("RUNNING")
            const imageService = new ImageService();
            Sender.send(res, { success: true, data: await imageService.find({ userId: req.params.id, type: "USER" }), status: 200 })
        } catch (error) {
            Sender.errorSend(res, { success: false, msg: error.message, status: 500 });
        }
    }
    async imageRemove(req: Request, res: Response) {
        try {
            const imageService = new ImageService();
            const image: any = async (path) => { // MINI Function 
                return await Cloudinary.remove(path);
            }
            const deletedImage = await imageService.findOne({ id: req.body.id, userId: req['user'].id, type: "USER" })
            await image(deletedImage.cloudinaryId);
            Sender.send(res, { success: true, msg: "Image deleted", data: await imageService.delete({ userId: req['user'].id, type: "USER", id: req.body.id }), status: 200 })
        } catch (error) {
            Sender.errorSend(res, { success: false, msg: error.message, status: 500 });
        }
    }
}
